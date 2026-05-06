/**
 * useWhisperVoiceInput — WhisperKit-backed voice input implementation.
 *
 * Extracted from the original useVoiceInput (Phase 3) so the router in
 * useVoiceInput can call both engines without violating React's Rules of Hooks.
 * The public return shape is identical to useSFSpeechVoiceInput.
 *
 * When `enabled` is false this hook short-circuits to an idle no-op — no event
 * subscriptions are registered and no audio session is touched.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { WhisperKit } from "whisperkit";
import type {
  WhisperConfirmedEvent,
  WhisperPartialEvent,
  WhisperErrorEvent,
} from "whisperkit";
import { requestIfNeeded } from "../permissions";
import { useWhisperModelState } from "../whisper-model-state";
import type {
  VoiceInputError,
  VoiceInputState,
  UseVoiceInputOptions,
  UseVoiceInputResult,
} from "../types";

// ---------------------------------------------------------------------------
// Error mapper (same as before, kept here to avoid coupling to the router)
// ---------------------------------------------------------------------------

/**
 * Maps native WhisperKit error codes to our VoiceInputError discriminated union.
 *
 * Known WhisperErrorEvent.code values from the native bridge:
 *   "MODEL_LOAD_FAILED"    → model files corrupted or missing
 *   "AUDIO_SESSION_ERROR"  → microphone hardware / AVAudioSession error
 *   "TRANSCRIPTION_ERROR"  → mid-stream pipeline crash
 *   "ALREADY_RUNNING"      → start() called while already recording
 *   "NOT_INITIALIZED"      → start() called before init()
 *   "UNKNOWN_MODEL"        → model name not recognised by the bridge
 */
function mapWhisperError(code: string, message: string): VoiceInputError {
  switch (code) {
    case "MODEL_LOAD_FAILED":
    case "UNKNOWN_MODEL":
      return { kind: "whisper_init_failed", message };

    case "AUDIO_SESSION_ERROR":
      return { kind: "audio_session", message };

    case "TRANSCRIPTION_ERROR":
    case "ALREADY_RUNNING":
    case "NOT_INITIALIZED":
      return { kind: "whisper_runtime_error", message };

    default:
      return { kind: "unknown", message };
  }
}

// ---------------------------------------------------------------------------
// Hook options (extends public options with internal `enabled` gate)
// ---------------------------------------------------------------------------

export interface UseWhisperVoiceInputOptions extends UseVoiceInputOptions {
  /**
   * When false the hook becomes a transparent no-op returning idle state.
   * Used by the router in useVoiceInput to keep both hook slots always
   * mounted (satisfying React Rules of Hooks) while only activating one.
   */
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Idle stub returned when enabled === false
// ---------------------------------------------------------------------------

const IDLE_STATE: VoiceInputState = { kind: "idle" };
const NOOP = async (): Promise<void> => undefined;
const NOOP_SYNC = (): void => undefined;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useWhisperVoiceInput(
  opts: UseWhisperVoiceInputOptions,
): UseVoiceInputResult {
  const { enabled, onFinalTranscript } = opts;

  const onFinalTranscriptRef = useRef<((text: string) => void) | undefined>(
    onFinalTranscript,
  );
  useEffect(() => {
    onFinalTranscriptRef.current = onFinalTranscript;
  }, [onFinalTranscript]);

  const modelStatus = useWhisperModelState((s) => s.status);
  const modelProgress = useWhisperModelState((s) => s.progress);
  const activeModel = useWhisperModelState((s) => s.activeModel);
  const ensureReady = useWhisperModelState((s) => s.ensureReady);

  const [state, setState] = useState<VoiceInputState>(IDLE_STATE);
  const [transcript, setTranscript] = useState<string>("");
  const [partialTranscript, setPartialTranscript] = useState<string>("");
  const [error, setError] = useState<VoiceInputError | null>(null);

  const transcriptRef = useRef<string>("");
  const isListeningRef = useRef<boolean>(false);
  const [isListening, setIsListening] = useState<boolean>(false);
  const initedForRef = useRef<string | null>(null);
  const stopResolversRef = useRef<Array<() => void>>([]);
  const cancelledRef = useRef<boolean>(false);

  // -------------------------------------------------------------------------
  // WhisperKit event subscriptions — only when enabled
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!enabled || Platform.OS !== "ios") return;

    const partialSub = WhisperKit.addPartialListener(
      (e: WhisperPartialEvent) => {
        if (!isListeningRef.current) return;
        setPartialTranscript(e.text);
        setState((prev) =>
          prev.kind === "recording"
            ? { kind: "recording", partialTranscript: e.text }
            : prev,
        );
      },
    );

    const confirmedSub = WhisperKit.addConfirmedListener(
      (e: WhisperConfirmedEvent) => {
        if (!isListeningRef.current) return;

        if (!cancelledRef.current) {
          const prev = transcriptRef.current;
          const next = prev.length > 0 ? `${prev} ${e.text}` : e.text;
          transcriptRef.current = next;
          setTranscript(next);
          setPartialTranscript("");
          setState((s) =>
            s.kind === "recording"
              ? { kind: "recording", partialTranscript: "" }
              : s,
          );
        }
      },
    );

    const errorSub = WhisperKit.addErrorListener((e: WhisperErrorEvent) => {
      if (!isListeningRef.current) return;

      const voiceError = mapWhisperError(e.code, e.message);
      isListeningRef.current = false;
      cancelledRef.current = false;
      setIsListening(false);
      setError(voiceError);
      setState({ kind: "error", error: voiceError });

      const resolvers = stopResolversRef.current.splice(0);
      for (const resolve of resolvers) resolve();
    });

    return () => {
      partialSub.remove();
      confirmedSub.remove();
      errorSub.remove();
    };
  }, [enabled]);

  // -------------------------------------------------------------------------
  // Cleanup on unmount
  // -------------------------------------------------------------------------

  useEffect(() => {
    return () => {
      if (isListeningRef.current) {
        cancelledRef.current = true;
        isListeningRef.current = false;
        if (Platform.OS === "ios") {
          void WhisperKit.stop().catch(() => undefined);
        }
        const resolvers = stopResolversRef.current.splice(0);
        for (const resolve of resolvers) resolve();
      }
    };
  }, []);

  // -------------------------------------------------------------------------
  // Stable ref for activeModel so stop() can read it without re-creating.
  // -------------------------------------------------------------------------

  const activeModelRef = useRef<string>(activeModel);
  useEffect(() => {
    activeModelRef.current = activeModel;
  }, [activeModel]);

  // -------------------------------------------------------------------------
  // Public methods
  // -------------------------------------------------------------------------

  const start = useCallback(async (): Promise<void> => {
    if (!enabled) return;
    if (isListeningRef.current) return;

    const currentStatus = useWhisperModelState.getState().status;
    if (currentStatus !== "ready") {
      const notReadyError: VoiceInputError = {
        kind: "model_not_ready",
        message: "Model not downloaded. Call ensureModelReady() first.",
      };
      setError(notReadyError);
      setState({ kind: "error", error: notReadyError });
      throw notReadyError;
    }

    cancelledRef.current = false;
    setError(null);
    transcriptRef.current = "";
    setTranscript("");
    setPartialTranscript("");
    setState({ kind: "requesting_permission" });

    const permStatus = await requestIfNeeded();
    if (permStatus !== "granted") {
      const permError: VoiceInputError = {
        kind: "permission_denied",
        message:
          permStatus === "restricted"
            ? "Speech recognition is restricted by device policy."
            : "Microphone or speech recognition permission was denied.",
      };
      setError(permError);
      setState({ kind: "error", error: permError });
      return;
    }

    if (Platform.OS !== "ios") {
      const platformError: VoiceInputError = {
        kind: "module_error",
        message: "WhisperKit is only available on iOS.",
      };
      setError(platformError);
      setState({ kind: "error", error: platformError });
      return;
    }

    const modelName = useWhisperModelState.getState().activeModel;
    if (initedForRef.current !== modelName) {
      try {
        await WhisperKit.init(modelName);
        initedForRef.current = modelName;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "WhisperKit init failed";
        const initError: VoiceInputError = {
          kind: "whisper_init_failed",
          message: msg,
        };
        setError(initError);
        setState({ kind: "error", error: initError });
        return;
      }
    }

    try {
      await WhisperKit.start();
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "WhisperKit start failed";
      const startError: VoiceInputError = {
        kind: "whisper_runtime_error",
        message: msg,
      };
      setError(startError);
      setState({ kind: "error", error: startError });
      return;
    }

    isListeningRef.current = true;
    setIsListening(true);
    setState({ kind: "recording", partialTranscript: "" });
  }, [enabled]);

  const stop = useCallback((): Promise<void> => {
    return new Promise<void>((resolve) => {
      if (!isListeningRef.current) {
        resolve();
        return;
      }

      stopResolversRef.current.push(resolve);
      setState({ kind: "stopping" });
      setIsListening(false);
      isListeningRef.current = false;

      void WhisperKit.stop()
        .then((trailing: string) => {
          if (!cancelledRef.current) {
            // Append the trailing hypothesis returned by the native bridge.
            // Whisper's stream stop doesn't promote unconfirmed → confirmed,
            // so this captures the tail of the utterance.
            const cleanTrailing = trailing.trim();
            let finalText = transcriptRef.current;
            if (cleanTrailing.length > 0) {
              finalText = finalText.length > 0
                ? `${finalText} ${cleanTrailing}`
                : cleanTrailing;
              transcriptRef.current = finalText;
              setTranscript(finalText);
            }
            setPartialTranscript("");
            if (finalText.length > 0) {
              onFinalTranscriptRef.current?.(finalText);
            }
          }
          cancelledRef.current = false;
          setState({ kind: "idle" });
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : "Stop failed";
          const stopError: VoiceInputError = {
            kind: "whisper_runtime_error",
            message: msg,
          };
          setError(stopError);
          setState({ kind: "error", error: stopError });
        })
        .finally(() => {
          const resolvers = stopResolversRef.current.splice(0);
          for (const resolve of resolvers) resolve();
        });
    });
  }, []);

  const cancel = useCallback((): void => {
    if (!isListeningRef.current) return;

    cancelledRef.current = true;
    isListeningRef.current = false;
    setIsListening(false);
    setState({ kind: "stopping" });

    void WhisperKit.stop()
      .catch(() => undefined)
      .finally(() => {
        cancelledRef.current = false;
        setState({ kind: "idle" });
        const resolvers = stopResolversRef.current.splice(0);
        for (const resolve of resolvers) resolve();
      });
  }, []);

  const reset = useCallback((): void => {
    transcriptRef.current = "";
    setTranscript("");
    setPartialTranscript("");
    setError(null);
    setState((prev) => (prev.kind === "idle" ? prev : { kind: "idle" }));
  }, []);

  const ensureModelReady = useCallback(async (): Promise<void> => {
    try {
      await ensureReady();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Model download failed";
      const dlError: VoiceInputError = {
        kind: "model_download_failed",
        message: msg,
      };
      setError(dlError);
      throw dlError;
    }
  }, [ensureReady]);

  // When not enabled, return pure idle state without exposing any live refs.
  if (!enabled) {
    return {
      state: IDLE_STATE,
      transcript: "",
      partialTranscript: "",
      isListening: false,
      error: null,
      modelStatus,
      modelProgress,
      start: NOOP,
      stop: NOOP,
      cancel: NOOP_SYNC,
      reset: NOOP_SYNC,
      ensureModelReady: NOOP,
      // Cap timer lives in the parent router (useVoiceInput); always null here.
      capExceededAt: null,
    };
  }

  return {
    state,
    transcript,
    partialTranscript,
    isListening,
    error,
    modelStatus,
    modelProgress,
    start,
    stop,
    cancel,
    reset,
    ensureModelReady,
    // Cap timer lives in the parent router (useVoiceInput); always null here.
    capExceededAt: null,
  };
}
