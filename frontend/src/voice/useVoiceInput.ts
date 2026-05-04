/**
 * useVoiceInput — state-machine hook for voice transcription.
 *
 * Manages the full lifecycle of a single recording session:
 *   idle → requesting_permission → recording → stopping → idle
 *                                                       ↘ error
 *
 * Subscribes to ExpoSpeechRecognitionModule events via useSpeechRecognitionEvent.
 * Default language is resolved from the device locale (Intl API); can be
 * overridden via opts.language.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from "expo-speech-recognition";
import type {
  ExpoSpeechRecognitionErrorCode,
  ExpoSpeechRecognitionErrorEvent,
  ExpoSpeechRecognitionResultEvent,
} from "expo-speech-recognition";
import { requestIfNeeded } from "./permissions";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type VoiceInputError =
  | { kind: "permission_denied"; message: string }
  | { kind: "no_speech"; message: string }
  | { kind: "audio_session"; message: string }
  | { kind: "module_error"; message: string }
  | { kind: "unknown"; message: string };

export type VoiceInputState =
  | { kind: "idle" }
  | { kind: "requesting_permission" }
  | { kind: "recording"; partialTranscript: string }
  | { kind: "stopping" }
  | { kind: "error"; error: VoiceInputError };

export interface UseVoiceInputOptions {
  /**
   * Override locale; default = device locale resolved via Intl API.
   * e.g. "en-US", "es-ES", "de-DE"
   */
  language?: string;
  /**
   * Apple's auto-punctuation (SFSpeechRecognitionRequest.addsPunctuation).
   * Default true.
   */
  addsPunctuation?: boolean;
  /**
   * Called when a final transcript arrives. Useful for ChatInput integration.
   * Not called when cancel() was used to discard the recording.
   */
  onFinalTranscript?: (text: string) => void;
}

export interface UseVoiceInputResult {
  state: VoiceInputState;
  /**
   * Last finalized transcript. Stays set until reset() is called or a new
   * start() + final result cycle completes.
   */
  transcript: string;
  start: () => Promise<void>;
  /**
   * Requests a graceful stop. Returns a promise that resolves once the native
   * `end` event fires (i.e. the recognizer has fully wound down).
   */
  stop: () => Promise<void>;
  /**
   * Discards the current recording immediately. Any in-flight result event is
   * ignored. onFinalTranscript is NOT called.
   */
  cancel: () => void;
  /**
   * Clears the last finalized transcript and returns state to idle.
   * No-op if already idle.
   */
  reset: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Device locale from the JS Intl API.
 * React Native's Hermes engine exposes Intl; this is the same approach
 * recommended by the plan (D4) when expo-localization is not installed.
 */
function resolveDeviceLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale ?? "en-US";
  } catch {
    return "en-US";
  }
}

/**
 * Maps the error code string from expo-speech-recognition to our VoiceInputError.
 *
 * Error code reference (ExpoSpeechRecognitionErrorCode):
 *   "not-allowed"        → permission was denied
 *   "no-speech"          → silence timeout
 *   "audio-capture"      → microphone hardware/session error
 *   "interrupted"        → iOS audio session interrupted (call, Siri, alarm)
 *   "service-not-allowed"→ recognizer not available (also permission-related)
 *   "network"            → network error during cloud recognition
 *   "language-not-supported" → bad locale
 *   "bad-grammar"        → grammar/semantic tag error
 *   "busy"               → recognizer busy
 *   "aborted"            → cancel() was called (we'll intercept before here)
 *   "speech-timeout"     → Android: no speech input
 *   "client"             → Android client-side error
 *   "unknown"            → fallback
 */
function mapErrorCode(
  code: ExpoSpeechRecognitionErrorCode,
  message: string
): VoiceInputError {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return { kind: "permission_denied", message };

    case "no-speech":
    case "speech-timeout":
      return { kind: "no_speech", message };

    case "audio-capture":
    case "interrupted":
      return { kind: "audio_session", message };

    case "network":
    case "language-not-supported":
    case "bad-grammar":
    case "busy":
    case "client":
      return { kind: "module_error", message };

    case "aborted":
    case "unknown":
    default:
      return { kind: "unknown", message };
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useVoiceInput(opts?: UseVoiceInputOptions): UseVoiceInputResult {
  const addsPunctuation = opts?.addsPunctuation ?? true;
  const onFinalTranscript = opts?.onFinalTranscript;

  // Resolve the language to use. Re-resolves whenever opts.language changes.
  const language = opts?.language ?? resolveDeviceLocale();

  // Keep a stable ref to the latest onFinalTranscript callback so event
  // handlers close over the ref rather than a stale copy.
  const onFinalTranscriptRef = useRef<((text: string) => void) | undefined>(
    onFinalTranscript
  );
  useEffect(() => {
    onFinalTranscriptRef.current = onFinalTranscript;
  }, [onFinalTranscript]);

  const [state, setState] = useState<VoiceInputState>({ kind: "idle" });
  const [transcript, setTranscript] = useState<string>("");

  // Flags that survive re-renders without causing them.
  // cancelledRef: set by cancel(), tells result handler to drop next final result.
  const cancelledRef = useRef<boolean>(false);
  // stopResolversRef: queue of resolve callbacks for pending stop() promises.
  const stopResolversRef = useRef<Array<() => void>>([]);
  // activeRef: true between start() and the `end` event. Guards against
  // stale event callbacks firing after unmount.
  const activeRef = useRef<boolean>(false);

  // -------------------------------------------------------------------------
  // Event subscriptions (always active — useSpeechRecognitionEvent registers
  // the listener for the component lifetime; we gate on activeRef internally)
  // -------------------------------------------------------------------------

  useSpeechRecognitionEvent(
    "result",
    useCallback(
      (event: ExpoSpeechRecognitionResultEvent) => {
        if (!activeRef.current) return;

        const text = event.results[0]?.transcript ?? "";

        if (event.isFinal) {
          if (!cancelledRef.current) {
            setTranscript(text);
            onFinalTranscriptRef.current?.(text);
          }
          // After a final result the native side will fire `end` shortly; we
          // stay in `stopping` state until that arrives.
        } else {
          // Partial update — only update if still recording (not already stopping).
          setState((prev) => {
            if (prev.kind === "recording") {
              return { kind: "recording", partialTranscript: text };
            }
            return prev;
          });
        }
      },
      [] // stable — reads refs only
    )
  );

  useSpeechRecognitionEvent(
    "error",
    useCallback(
      (event: ExpoSpeechRecognitionErrorEvent) => {
        if (!activeRef.current) return;

        // "aborted" fires when we called abort() ourselves (via cancel or
        // stop). Treat it as a normal end rather than an error.
        if (event.error === "aborted") {
          return;
        }

        activeRef.current = false;
        cancelledRef.current = false;
        const voiceError = mapErrorCode(event.error, event.message ?? event.error);
        setState({ kind: "error", error: voiceError });
      },
      []
    )
  );

  useSpeechRecognitionEvent(
    "end",
    useCallback(() => {
      if (!activeRef.current) return;

      activeRef.current = false;
      cancelledRef.current = false;

      setState({ kind: "idle" });

      // Resolve any waiting stop() promises.
      const resolvers = stopResolversRef.current.splice(0);
      for (const resolve of resolvers) {
        resolve();
      }
    }, [])
  );

  // -------------------------------------------------------------------------
  // Public methods
  // -------------------------------------------------------------------------

  const start = useCallback(async (): Promise<void> => {
    // Ignore if already active.
    if (activeRef.current) return;

    cancelledRef.current = false;
    setState({ kind: "requesting_permission" });

    const status = await requestIfNeeded();

    if (status !== "granted") {
      setState({
        kind: "error",
        error: {
          kind: "permission_denied",
          message:
            status === "restricted"
              ? "Speech recognition is restricted by device policy."
              : "Microphone or speech recognition permission was denied.",
        },
      });
      return;
    }

    activeRef.current = true;
    setState({ kind: "recording", partialTranscript: "" });

    ExpoSpeechRecognitionModule.start({
      lang: language,
      interimResults: true,
      continuous: true,
      addsPunctuation,
      requiresOnDeviceRecognition: false,
    });
  }, [language, addsPunctuation]);

  const stop = useCallback((): Promise<void> => {
    return new Promise<void>((resolve) => {
      if (!activeRef.current) {
        // Not recording — resolve immediately.
        resolve();
        return;
      }

      stopResolversRef.current.push(resolve);
      setState({ kind: "stopping" });
      ExpoSpeechRecognitionModule.stop();
    });
  }, []);

  const cancel = useCallback((): void => {
    if (!activeRef.current) return;

    cancelledRef.current = true;
    // Use stop() rather than abort() so the `end` event still fires and we
    // transition cleanly back to idle. The result event, if any, is dropped
    // because cancelledRef is set.
    setState({ kind: "stopping" });
    ExpoSpeechRecognitionModule.stop();
  }, []);

  const reset = useCallback((): void => {
    setTranscript("");
    setState((prev) =>
      prev.kind === "idle" ? prev : { kind: "idle" }
    );
  }, []);

  // -------------------------------------------------------------------------
  // Cleanup: if the component unmounts while recording, stop silently.
  // -------------------------------------------------------------------------
  useEffect(() => {
    return () => {
      if (activeRef.current) {
        cancelledRef.current = true;
        activeRef.current = false;
        ExpoSpeechRecognitionModule.stop();
        // Drain any pending stop resolvers so callers aren't left hanging.
        const resolvers = stopResolversRef.current.splice(0);
        for (const resolve of resolvers) {
          resolve();
        }
      }
    };
  }, []);

  return { state, transcript, start, stop, cancel, reset };
}
