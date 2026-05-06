/**
 * Shared public types for voice input.
 *
 * Extracted to break the circular dependency between useVoiceInput (router)
 * and the internal implementations (useWhisperVoiceInput, useSFSpeechVoiceInput).
 * All three import from here; none import from each other.
 */

// ---------------------------------------------------------------------------
// Error discriminated union
// ---------------------------------------------------------------------------

export type VoiceInputError =
  | { kind: "permission_denied"; message: string }
  | { kind: "no_speech"; message: string }
  | { kind: "audio_session"; message: string }
  | { kind: "module_error"; message: string }
  | { kind: "model_not_ready"; message: string }
  | { kind: "model_download_failed"; message: string }
  | { kind: "whisper_init_failed"; message: string }
  | { kind: "whisper_runtime_error"; message: string }
  | { kind: "unknown"; message: string };

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export type VoiceInputState =
  | { kind: "idle" }
  | { kind: "requesting_permission" }
  | { kind: "recording"; partialTranscript: string }
  | { kind: "stopping" }
  | { kind: "error"; error: VoiceInputError };

// ---------------------------------------------------------------------------
// Hook options + result
// ---------------------------------------------------------------------------

export interface UseVoiceInputOptions {
  /**
   * Override locale; default = device locale resolved via Intl API.
   * e.g. "en-US", "es-ES", "de-DE"
   */
  language?: string;
  /**
   * Apple's auto-punctuation (SFSpeechRecognitionRequest.addsPunctuation).
   * Default true. Only meaningful when the SFSpeech engine is active.
   * @deprecated No-op in the WhisperKit backend. Retained for API compatibility.
   */
  addsPunctuation?: boolean;
  /**
   * Called when a final transcript arrives.
   * Not called when cancel() was used to discard the recording.
   */
  onFinalTranscript?: (text: string) => void;
}

export interface UseVoiceInputResult {
  /** Full voice state machine state. */
  state: VoiceInputState;
  /**
   * Last finalized transcript. Stays set until reset() or a new session begins.
   */
  transcript: string;
  /**
   * Current hypothesis (unconfirmed tail). Empty when not recording.
   */
  partialTranscript: string;
  /** Whether a recording session is active. */
  isListening: boolean;
  /** Last error encountered, or null. */
  error: VoiceInputError | null;
  /**
   * Lifecycle status of the active WhisperKit model.
   * SFSpeech engine always returns "ready".
   */
  modelStatus: "absent" | "downloading" | "ready" | "failed";
  /**
   * Download progress in [0, 1].
   * SFSpeech engine always returns 1.
   */
  modelProgress: number;
  /** Start a recording session. */
  start: () => Promise<void>;
  /** Graceful stop — flushes remaining tokens. */
  stop: () => Promise<void>;
  /** Discards the recording immediately; onFinalTranscript is NOT called. */
  cancel: () => void;
  /** Clears transcript + error and returns to idle. */
  reset: () => void;
  /**
   * Trigger a model download if absent.
   * No-op for SFSpeech engine (always ready).
   */
  ensureModelReady: () => Promise<void>;
}
