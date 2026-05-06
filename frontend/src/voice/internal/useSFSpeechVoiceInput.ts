/**
 * useSFSpeechVoiceInput — SFSpeech (expo-speech-recognition) backed voice input.
 *
 * Return shape is identical to useWhisperVoiceInput so the router in
 * useVoiceInput can switch between them transparently.
 *
 * Stubs for WhisperKit-specific fields:
 *   modelStatus  → always "ready" (SFSpeech needs no download)
 *   modelProgress → always 1
 *   ensureModelReady → no-op
 *
 * Partial transcripts come from expo-speech-recognition's `interimResults`
 * option (SFSpeech does support interim results on iOS 16+).
 *
 * When `enabled` is false this hook becomes a transparent no-op — no event
 * subscriptions are registered, no audio session is touched.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";
import type { ExpoSpeechRecognitionErrorCode } from "expo-speech-recognition";
import { requestIfNeeded } from "../permissions";
import type {
  VoiceInputError,
  VoiceInputState,
  UseVoiceInputOptions,
  UseVoiceInputResult,
} from "../types";

// ---------------------------------------------------------------------------
// Error mapper
// ---------------------------------------------------------------------------

/**
 * Maps expo-speech-recognition error codes to our VoiceInputError shape.
 *
 * SFSpeech error codes from ExpoSpeechRecognitionErrorCode:
 *   "not-allowed"         → permission denied
 *   "audio-capture"       → microphone / AVAudioSession error
 *   "interrupted"         → audio session interrupted
 *   "no-speech"           → no speech detected
 *   "aborted"             → user called abort() / cancel()
 *   "service-not-allowed" → SFSpeech unavailable
 *   "network"             → network-based recognition failed
 *   "language-not-supported" → locale not available
 *   "busy"                → recognizer in use
 *   others                → unknown
 */
function mapSFSpeechError(
  code: ExpoSpeechRecognitionErrorCode,
  message: string,
): VoiceInputError {
  switch (code) {
    case "not-allowed":
      return { kind: "permission_denied", message };

    case "audio-capture":
    case "interrupted":
      return { kind: "audio_session", message };

    case "no-speech":
    case "speech-timeout":
      return { kind: "no_speech", message };

    case "aborted":
      // aborted is triggered by cancel() — callers check cancelledRef
      // and swallow this; map to unknown so it surfaces if unexpectedly raised.
      return { kind: "unknown", message };

    case "service-not-allowed":
    case "busy":
    case "network":
    case "language-not-supported":
    case "bad-grammar":
    case "client":
    case "unknown":
      return { kind: "module_error", message };

    default:
      return { kind: "unknown", message };
  }
}

// ---------------------------------------------------------------------------
// Hook options
// ---------------------------------------------------------------------------

export interface UseSFSpeechVoiceInputOptions extends UseVoiceInputOptions {
  /**
   * When false the hook becomes a transparent no-op.
   * @see useWhisperVoiceInput for the same pattern.
   */
  enabled: boolean;
  /**
   * Whether to request Apple's auto-punctuation.
   * Passed through to ExpoSpeechRecognitionOptions.addsPunctuation.
   */
  addsPunctuation?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IDLE_STATE: VoiceInputState = { kind: "idle" };
const NOOP = async (): Promise<void> => undefined;
const NOOP_SYNC = (): void => undefined;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useSFSpeechVoiceInput(
  opts: UseSFSpeechVoiceInputOptions,
): UseVoiceInputResult {
  const { enabled, language, addsPunctuation, onFinalTranscript } = opts;

  const onFinalTranscriptRef = useRef<((text: string) => void) | undefined>(
    onFinalTranscript,
  );
  useEffect(() => {
    onFinalTranscriptRef.current = onFinalTranscript;
  }, [onFinalTranscript]);

  const [state, setState] = useState<VoiceInputState>(IDLE_STATE);
  const [transcript, setTranscript] = useState<string>("");
  const [partialTranscript, setPartialTranscript] = useState<string>("");
  const [error, setError] = useState<VoiceInputError | null>(null);
  const [isListening, setIsListening] = useState<boolean>(false);

  // Accumulates confirmed text within a session.
  const transcriptRef = useRef<string>("");
  const isListeningRef = useRef<boolean>(false);
  // Set by cancel() to suppress onFinalTranscript and swallow the abort error.
  const cancelledRef = useRef<boolean>(false);
  // Resolvers for pending stop() promises — drained in the `end` event handler.
  const stopResolversRef = useRef<Array<() => void>>([]);

  // -------------------------------------------------------------------------
  // SFSpeech event subscriptions — only when enabled
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!enabled) return;

    // `result` fires for both interim (isFinal: false) and final (isFinal: true) results.
    const resultSub = ExpoSpeechRecognitionModule.addListener(
      "result",
      (event) => {
        if (!isListeningRef.current) return;

        const best = event.results[0];
        if (!best) return;

        if (!event.isFinal) {
          // Interim result — update the hypothesis tail.
          setPartialTranscript(best.transcript);
          setState((prev) =>
            prev.kind === "recording"
              ? { kind: "recording", partialTranscript: best.transcript }
              : prev,
          );
        } else {
          // Final result for this segment — commit to transcript.
          if (!cancelledRef.current) {
            const prev = transcriptRef.current;
            const next =
              prev.length > 0 ? `${prev} ${best.transcript}` : best.transcript;
            transcriptRef.current = next;
            setTranscript(next);
          }
          setPartialTranscript("");
          setState((prev) =>
            prev.kind === "recording"
              ? { kind: "recording", partialTranscript: "" }
              : prev,
          );
        }
      },
    );

    const errorSub = ExpoSpeechRecognitionModule.addListener(
      "error",
      (event) => {
        if (!isListeningRef.current) return;

        // Suppress abort errors triggered by our own cancel() call.
        if (cancelledRef.current && event.error === "aborted") return;

        const voiceError = mapSFSpeechError(event.error, event.message);
        isListeningRef.current = false;
        cancelledRef.current = false;
        setIsListening(false);
        setError(voiceError);
        setState({ kind: "error", error: voiceError });

        // Drain stop() resolvers so callers aren't left hanging.
        const resolvers = stopResolversRef.current.splice(0);
        for (const resolve of resolvers) resolve();
      },
    );

    // `end` fires when SFSpeech finishes (after stop() is called or auto-stops).
    const endSub = ExpoSpeechRecognitionModule.addListener("end", () => {
      if (!isListeningRef.current) return;

      if (!cancelledRef.current) {
        const finalText = transcriptRef.current;
        if (finalText.length > 0) {
          onFinalTranscriptRef.current?.(finalText);
        }
      }
      cancelledRef.current = false;
      isListeningRef.current = false;
      setIsListening(false);
      setState({ kind: "idle" });

      // Drain stop() promise resolvers regardless of whether there was a transcript.
      const resolvers = stopResolversRef.current.splice(0);
      for (const resolve of resolvers) resolve();
    });

    return () => {
      resultSub.remove();
      errorSub.remove();
      endSub.remove();
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
        ExpoSpeechRecognitionModule.abort();
        const resolvers = stopResolversRef.current.splice(0);
        for (const resolve of resolvers) resolve();
      }
    };
  }, []);

  // -------------------------------------------------------------------------
  // Public methods
  // -------------------------------------------------------------------------

  const start = useCallback(async (): Promise<void> => {
    if (!enabled) return;
    if (isListeningRef.current) return;

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

    // Determine locale: prefer the explicit language opt, then device locale.
    const lang =
      language ??
      (() => {
        try {
          return Intl.DateTimeFormat().resolvedOptions().locale ?? "en-US";
        } catch {
          return "en-US";
        }
      })();

    ExpoSpeechRecognitionModule.start({
      lang,
      interimResults: true,
      continuous: true,
      addsPunctuation: addsPunctuation ?? true,
      requiresOnDeviceRecognition: false,
    });

    isListeningRef.current = true;
    setIsListening(true);
    setState({ kind: "recording", partialTranscript: "" });
  }, [enabled, language, addsPunctuation]);

  const stop = useCallback((): Promise<void> => {
    return new Promise<void>((resolve) => {
      if (!isListeningRef.current) {
        resolve();
        return;
      }

      // Queue the resolver — drained by the `end` event handler (or error handler).
      stopResolversRef.current.push(resolve);
      setState({ kind: "stopping" });
      ExpoSpeechRecognitionModule.stop();
    });
  }, []);

  const cancel = useCallback((): void => {
    if (!isListeningRef.current) return;

    cancelledRef.current = true;
    isListeningRef.current = false;
    setIsListening(false);
    setState({ kind: "stopping" });

    ExpoSpeechRecognitionModule.abort();
    // The `end` or `error(aborted)` event will fire; our handlers check
    // cancelledRef and skip onFinalTranscript, then transition to idle.
  }, []);

  const reset = useCallback((): void => {
    transcriptRef.current = "";
    setTranscript("");
    setPartialTranscript("");
    setError(null);
    setState((prev) => (prev.kind === "idle" ? prev : { kind: "idle" }));
  }, []);

  // SFSpeech requires no model download — these are stubs.
  const ensureModelReady = useCallback((): Promise<void> => {
    return Promise.resolve();
  }, []);

  // When not enabled, return pure idle state.
  if (!enabled) {
    return {
      state: IDLE_STATE,
      transcript: "",
      partialTranscript: "",
      isListening: false,
      error: null,
      modelStatus: "ready",
      modelProgress: 1,
      start: NOOP,
      stop: NOOP,
      cancel: NOOP_SYNC,
      reset: NOOP_SYNC,
      ensureModelReady: NOOP,
    };
  }

  return {
    state,
    transcript,
    partialTranscript,
    isListening,
    error,
    // SFSpeech stubs — no model lifecycle to track.
    modelStatus: "ready",
    modelProgress: 1,
    start,
    stop,
    cancel,
    reset,
    ensureModelReady,
  };
}
