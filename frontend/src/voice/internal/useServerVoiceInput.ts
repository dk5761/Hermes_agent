/**
 * useServerVoiceInput — server-side STT backed voice input.
 *
 * Records a local M4A via expo-av, uploads it to the Hermes gateway
 * (`POST /sessions/:id/transcribe`), and returns the transcript as a
 * single-shot result. No streaming — state transitions to `transcribing`
 * while the upload + inference round-trip is in flight.
 *
 * Return shape is identical to useWhisperVoiceInput / useSFSpeechVoiceInput
 * so the router in useVoiceInput can swap engines transparently.
 *
 * Stubbed fields:
 *   partialTranscript — always "" (no streaming)
 *   modelStatus       — always "ready" (no model lifecycle)
 *   modelProgress     — always 1
 *   ensureModelReady  — no-op
 *
 * When `enabled` is false the hook returns idle no-ops without registering
 * any native resources — same pattern as the other two internal hooks.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system";
import { requestIfNeeded } from "../permissions";
import { postTranscribe, TranscribeError } from "../../api/transcribe";
import type {
  VoiceInputError,
  VoiceInputState,
  UseVoiceInputOptions,
  UseVoiceInputResult,
} from "../types";

// ---------------------------------------------------------------------------
// Hook options
// ---------------------------------------------------------------------------

export interface UseServerVoiceInputOptions extends UseVoiceInputOptions {
  /**
   * When false the hook becomes a transparent no-op.
   * @see useWhisperVoiceInput for the same pattern.
   */
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IDLE_STATE: VoiceInputState = { kind: "idle" };
const NOOP = async (): Promise<void> => undefined;
const NOOP_SYNC = (): void => undefined;
const MIME = "audio/m4a";

// ---------------------------------------------------------------------------
// Audio mode helpers
// ---------------------------------------------------------------------------

/**
 * Activate the iOS audio session for recording (playAndRecord so speaker is
 * still usable; playsInSilentModeIOS so recording works on silent switch).
 */
async function activateRecordingMode(): Promise<void> {
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: true,
    playsInSilentModeIOS: true,
  });
}

/**
 * Deactivate the recording audio mode — restores default playback settings
 * after the recording is stopped or cancelled.
 */
async function deactivateRecordingMode(): Promise<void> {
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: false,
    playsInSilentModeIOS: false,
  });
}

// ---------------------------------------------------------------------------
// File cleanup helper
// ---------------------------------------------------------------------------

async function deleteFile(uri: string | null | undefined): Promise<void> {
  if (!uri) return;
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // Best-effort — don't let cleanup failure surface to the user.
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useServerVoiceInput(
  opts: UseServerVoiceInputOptions,
): UseVoiceInputResult {
  const { enabled, onFinalTranscript, sessionId } = opts;

  // Keep onFinalTranscript in a ref so stop() can read the latest value
  // without being a dep of its useCallback.
  const onFinalTranscriptRef = useRef<((text: string) => void) | undefined>(
    onFinalTranscript,
  );
  useEffect(() => {
    onFinalTranscriptRef.current = onFinalTranscript;
  }, [onFinalTranscript]);

  const [state, setState] = useState<VoiceInputState>(IDLE_STATE);
  const [transcript, setTranscript] = useState<string>("");
  const [error, setError] = useState<VoiceInputError | null>(null);
  const [isListening, setIsListening] = useState<boolean>(false);

  // Persists finalised text across stop/reset without re-triggering renders
  // (mirrors the ref+state dual pattern used by the other two engines).
  const transcriptRef = useRef<string>("");

  // Current active Recording object — null when idle.
  const recordingRef = useRef<Audio.Recording | null>(null);

  // True between stop() call and upload completion — prevents double-stop.
  const stoppingRef = useRef<boolean>(false);

  // Set by cancel() to suppress upload and onFinalTranscript.
  const cancelledRef = useRef<boolean>(false);

  // -------------------------------------------------------------------------
  // Cleanup on unmount — stop recording and delete the temp file if active.
  // -------------------------------------------------------------------------

  useEffect(() => {
    return () => {
      const rec = recordingRef.current;
      if (rec) {
        cancelledRef.current = true;
        recordingRef.current = null;
        void rec
          .stopAndUnloadAsync()
          .catch(() => undefined)
          .then(() => {
            void deleteFile(rec.getURI());
            void deactivateRecordingMode().catch(() => undefined);
          });
      }
    };
  }, []);

  // -------------------------------------------------------------------------
  // start
  // -------------------------------------------------------------------------

  const start = useCallback(async (): Promise<void> => {
    if (!enabled) return;
    if (recordingRef.current || stoppingRef.current) return;

    cancelledRef.current = false;
    setError(null);
    transcriptRef.current = "";
    setTranscript("");
    setState({ kind: "requesting_permission" });

    const permStatus = await requestIfNeeded();
    if (permStatus !== "granted") {
      const permError: VoiceInputError = {
        kind: "permission_denied",
        message:
          permStatus === "restricted"
            ? "Speech recognition is restricted by device policy."
            : "Microphone permission was denied.",
      };
      setError(permError);
      setState({ kind: "error", error: permError });
      return;
    }

    try {
      await activateRecordingMode();
      const recording = new Audio.Recording();
      await recording.prepareToRecordAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY,
      );
      await recording.startAsync();
      recordingRef.current = recording;
      setIsListening(true);
      setState({ kind: "recording", partialTranscript: "" });
    } catch (err: unknown) {
      void deactivateRecordingMode().catch(() => undefined);
      const msg =
        err instanceof Error ? err.message : "Failed to start recording";
      const audioError: VoiceInputError = { kind: "audio_session", message: msg };
      setError(audioError);
      setState({ kind: "error", error: audioError });
    }
  }, [enabled]);

  // -------------------------------------------------------------------------
  // stop — uploads and awaits transcript
  // -------------------------------------------------------------------------

  const stop = useCallback(async (): Promise<void> => {
    const recording = recordingRef.current;
    if (!recording || stoppingRef.current) return;

    stoppingRef.current = true;
    recordingRef.current = null;
    setIsListening(false);

    let fileUri: string | null = null;

    try {
      await recording.stopAndUnloadAsync();
      fileUri = recording.getURI();
      await deactivateRecordingMode().catch(() => undefined);

      // Bail if cancelled between stopAndUnloadAsync and here.
      if (cancelledRef.current) {
        setState({ kind: "idle" });
        return;
      }

      if (!fileUri) {
        const noUriError: VoiceInputError = {
          kind: "audio_session",
          message: "Recording produced no output file.",
        };
        setError(noUriError);
        setState({ kind: "error", error: noUriError });
        return;
      }

      if (!sessionId) {
        const noSessionError: VoiceInputError = {
          kind: "server_stt_failed",
          message: "No active session ID — cannot upload audio.",
        };
        setError(noSessionError);
        setState({ kind: "error", error: noSessionError });
        return;
      }

      setState({ kind: "transcribing" });

      const result = await postTranscribe(sessionId, fileUri, MIME);
      const text = result.transcript;

      if (!cancelledRef.current) {
        transcriptRef.current = text;
        setTranscript(text);
        if (text.length > 0) {
          onFinalTranscriptRef.current?.(text);
        }
      }

      setState({ kind: "idle" });
    } catch (err: unknown) {
      await deactivateRecordingMode().catch(() => undefined);

      let voiceError: VoiceInputError;
      if (err instanceof TranscribeError) {
        voiceError = {
          kind: "server_stt_failed",
          message: err.message,
          status: err.status,
        };
      } else {
        const msg = err instanceof Error ? err.message : "Transcription failed";
        voiceError = { kind: "server_stt_failed", message: msg };
      }

      setError(voiceError);
      setState({ kind: "error", error: voiceError });
    } finally {
      // Always delete the temp recording file — success, error, or cancelled.
      await deleteFile(fileUri);
      cancelledRef.current = false;
      stoppingRef.current = false;
    }
  }, [sessionId]);

  // -------------------------------------------------------------------------
  // cancel — discard recording, no upload
  // -------------------------------------------------------------------------

  const cancel = useCallback((): void => {
    const recording = recordingRef.current;
    if (!recording) return;

    cancelledRef.current = true;
    recordingRef.current = null;
    setIsListening(false);

    void (async () => {
      try {
        await recording.stopAndUnloadAsync();
      } catch {
        // Ignore — we're discarding.
      }
      await deleteFile(recording.getURI());
      await deactivateRecordingMode().catch(() => undefined);
      cancelledRef.current = false;
      stoppingRef.current = false;
      setState({ kind: "idle" });
    })();
  }, []);

  // -------------------------------------------------------------------------
  // reset — clear transcript + error
  // -------------------------------------------------------------------------

  const reset = useCallback((): void => {
    transcriptRef.current = "";
    setTranscript("");
    setError(null);
    setState((prev) => (prev.kind === "idle" ? prev : { kind: "idle" }));
  }, []);

  // No model to manage — return a no-op promise.
  const ensureModelReady = useCallback((): Promise<void> => {
    return Promise.resolve();
  }, []);

  // -------------------------------------------------------------------------
  // Disabled / not enabled — return pure idle no-ops
  // -------------------------------------------------------------------------

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
      // Cap timer lives in the parent router (useVoiceInput); always null here.
      capExceededAt: null,
    };
  }

  return {
    state,
    transcript,
    partialTranscript: "",
    isListening,
    error,
    modelStatus: "ready",
    modelProgress: 1,
    start,
    stop,
    cancel,
    reset,
    ensureModelReady,
    // Cap timer lives in the parent router (useVoiceInput); always null here.
    capExceededAt: null,
  };
}
