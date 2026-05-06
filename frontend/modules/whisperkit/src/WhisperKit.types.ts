/** Hypothesis token — gray in the UI until confirmed. */
export interface WhisperPartialEvent {
  /** Partial transcript text for this segment. */
  text: string;
  /** Monotonically increasing ID for the segment being built. */
  segmentId: number;
}

/** Committed transcript token — the model won't revise this text. */
export interface WhisperConfirmedEvent {
  /** Finalised transcript text for this segment. */
  text: string;
  /** Same ID used in the preceding onPartial events for this segment. */
  segmentId: number;
}

/** Surfaced when the pipeline encounters a recoverable or fatal error. */
export interface WhisperErrorEvent {
  /**
   * Machine-readable error code.
   * Known values: "MODEL_LOAD_FAILED" | "AUDIO_SESSION_ERROR" |
   * "TRANSCRIPTION_ERROR" | "ALREADY_RUNNING" | "NOT_INITIALIZED" |
   * "UNKNOWN_MODEL"
   */
  code: string;
  /** Human-readable description of the error. */
  message: string;
}

/** Emitted during `ensureModel()` / `init()` when WhisperKit downloads a model variant. */
export interface WhisperModelDownloadProgressEvent {
  /** Completion fraction in [0, 1]. */
  fraction: number;
}

/** Arguments accepted by {@link WhisperKitNativeModule.init}. */
export interface WhisperInitOptions {
  /** WhisperKit model variant name, e.g. `"openai_whisper-tiny"`. */
  modelName: string;
}

/**
 * Snapshot of a model's local availability.
 *
 * Returned by `WhisperKit.modelInfo(modelName)` and used by the
 * `whisper-model-state` store to determine initial status.
 */
export interface WhisperModelInfo {
  /** The model variant name, e.g. `"openai_whisper-base.en"`. */
  name: string;
  /** Whether the model folder exists in the on-device cache. */
  downloaded: boolean;
  /** Absolute path to the model folder, or `null` if not yet downloaded. */
  pathOnDisk: string | null;
}

/**
 * All supported WhisperKit CoreML model variant names.
 *
 * These identifiers map directly to the directory names used by
 * `argmaxinc/whisperkit-coreml` on HuggingFace and are validated by the
 * Swift bridge before attempting a download.
 */
export type WhisperModelName =
  | "openai_whisper-tiny"
  | "openai_whisper-tiny.en"
  | "openai_whisper-base"
  | "openai_whisper-base.en"
  | "openai_whisper-small"
  | "openai_whisper-small.en"
  | "openai_whisper-medium"
  | "openai_whisper-medium.en"
  | "openai_whisper-large"
  | "openai_whisper-large-v2"
  | "openai_whisper-large-v3";
