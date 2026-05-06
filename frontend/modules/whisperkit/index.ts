/**
 * Thin JS wrapper around the WhisperKit native module.
 *
 * iOS-only. The native module is not linked on other platforms; callers should
 * guard with `Platform.OS === 'ios'` before calling any method.
 *
 * Recommended usage:
 *   1. `WhisperKit.ensureModel(name)` — download model if absent (emits progress).
 *   2. `WhisperKit.init(name)` — load model into memory (instant if already on disk).
 *   3. `WhisperKit.start()` → listen for events → `WhisperKit.stop()`
 *   4. `WhisperKit.release()` when done.
 *
 * Alternatively, call `WhisperKit.init(name)` directly — it combines steps 1 & 2.
 */
import { EventSubscription, requireNativeModule } from "expo-modules-core";

export type {
  WhisperConfirmedEvent,
  WhisperErrorEvent,
  WhisperModelDownloadProgressEvent,
  WhisperModelInfo,
  WhisperModelName,
  WhisperPartialEvent,
} from "./src/WhisperKit.types";

import type {
  WhisperConfirmedEvent,
  WhisperErrorEvent,
  WhisperModelDownloadProgressEvent,
  WhisperModelInfo,
  WhisperModelName,
  WhisperPartialEvent,
} from "./src/WhisperKit.types";

interface WhisperKitNativeModule {
  /**
   * Download the model variant from HuggingFace if it isn't cached locally.
   * Emits `onModelDownloadProgress` events while downloading.
   * No-op (progress immediately jumps to 1.0) if the model is already on disk.
   * @param modelName - e.g. `"openai_whisper-base.en"`
   */
  ensureModel(modelName: string): Promise<void>;

  /**
   * Returns `true` if the model folder exists in the on-device cache.
   * Does not require the model to be loaded into memory.
   */
  isModelDownloaded(modelName: string): Promise<boolean>;

  /**
   * Returns the absolute path to the model folder, or `null` if not cached.
   */
  modelLocationOnDisk(modelName: string): Promise<string | null>;

  /**
   * Boot a WhisperKit instance for the given model variant.
   * Internally calls `ensureModel` then loads the model into memory.
   * @param modelName - e.g. `"openai_whisper-base.en"`
   */
  init(modelName: string): Promise<void>;

  /** Start microphone capture and the streaming transcription pipeline. */
  start(): Promise<void>;

  /**
   * Stop the stream. Remaining tokens are flushed and emitted as confirmed
   * before the promise resolves.
   */
  stop(): Promise<string>;

  /** Free the WhisperKit instance and release the audio session. */
  release(): Promise<void>;

  addListener(
    eventName:
      | "onPartial"
      | "onConfirmed"
      | "onError"
      | "onModelDownloadProgress",
    listener: (event: unknown) => void,
  ): EventSubscription;
  removeListeners(count: number): void;
}

const NativeModule =
  requireNativeModule<WhisperKitNativeModule>("WhisperKit");

export const WhisperKit = {
  // ---------------------------------------------------------------------------
  // Model lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Download the model variant from HuggingFace if absent from the on-device
   * cache.  Emits `onModelDownloadProgress` events in [0, 1] while downloading.
   * Resolves immediately if the model is already cached.
   */
  ensureModel: (modelName: WhisperModelName): Promise<void> =>
    NativeModule.ensureModel(modelName),

  /**
   * Returns `true` if the model has been downloaded and is present in the
   * on-device cache. Does NOT require the model to be loaded into memory.
   */
  isModelDownloaded: (modelName: WhisperModelName): Promise<boolean> =>
    NativeModule.isModelDownloaded(modelName),

  /**
   * Returns the absolute path to the on-device model folder, or `null` if
   * the model has not been downloaded yet.
   */
  modelLocationOnDisk: (modelName: WhisperModelName): Promise<string | null> =>
    NativeModule.modelLocationOnDisk(modelName),

  /**
   * Convenience helper that bundles `isModelDownloaded` and
   * `modelLocationOnDisk` into a single {@link WhisperModelInfo} object.
   */
  modelInfo: async (modelName: WhisperModelName): Promise<WhisperModelInfo> => {
    const [downloaded, pathOnDisk] = await Promise.all([
      NativeModule.isModelDownloaded(modelName),
      NativeModule.modelLocationOnDisk(modelName),
    ]);
    return { name: modelName, downloaded, pathOnDisk };
  },

  // ---------------------------------------------------------------------------
  // Transcription lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Initialise the on-device model. Must be called before `start()`.
   * Internally calls `ensureModel` then loads; use `ensureModel` separately
   * if you want to drive a download-progress UI before loading.
   */
  init: (modelName: WhisperModelName): Promise<void> =>
    NativeModule.init(modelName),

  /** Start the microphone capture + streaming pipeline. */
  start: (): Promise<void> => NativeModule.start(),

  /**
   * Stop the stream. Resolves with the trailing hypothesis text — append
   * this to your accumulated transcript before firing your final-text
   * callback. Empty string if there was no pending hypothesis at stop.
   *
   * Returning this synchronously avoids a race where the bridged
   * `onConfirmed` flush event arrives AFTER stop() resolves on the JS side.
   */
  stop: (): Promise<string> => NativeModule.stop(),

  /** Free the WhisperKit instance and release the audio session. */
  release: (): Promise<void> => NativeModule.release(),

  // ---------------------------------------------------------------------------
  // Event listeners
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to hypothesis (partial) transcript events.
   * These represent the current best guess and may be revised.
   */
  addPartialListener: (
    cb: (e: WhisperPartialEvent) => void,
  ): EventSubscription =>
    NativeModule.addListener("onPartial", cb as (e: unknown) => void),

  /**
   * Subscribe to confirmed transcript segment events.
   * The model won't revise text emitted here.
   */
  addConfirmedListener: (
    cb: (e: WhisperConfirmedEvent) => void,
  ): EventSubscription =>
    NativeModule.addListener("onConfirmed", cb as (e: unknown) => void),

  /** Subscribe to pipeline error events. */
  addErrorListener: (
    cb: (e: WhisperErrorEvent) => void,
  ): EventSubscription =>
    NativeModule.addListener("onError", cb as (e: unknown) => void),

  /**
   * Subscribe to model download progress events.
   * Fires during `ensureModel()` / `init()` when the model isn't cached.
   * The single `fraction: 1.0` event also fires on cache hits.
   */
  addModelDownloadProgressListener: (
    cb: (e: WhisperModelDownloadProgressEvent) => void,
  ): EventSubscription =>
    NativeModule.addListener(
      "onModelDownloadProgress",
      cb as (e: unknown) => void,
    ),
} as const;
