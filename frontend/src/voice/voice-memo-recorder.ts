/**
 * voice-memo-recorder — expo-audio wrapper for the voice memo send path.
 *
 * Separate from the transcribe path (useServerVoiceInput) so that the two
 * recording sessions never share state. The memo path holds a recording until
 * the user releases the button; the transcribe path stops and uploads in one
 * shot. Keeping them separate avoids the ref-juggling that a unified recorder
 * would require.
 *
 * Usage:
 *   const recorder = new VoiceMemoRecorder();
 *   await recorder.start();
 *   // ... user holds the button ...
 *   const result = await recorder.stop();  // null if cancelled
 *   if (result) upload(result.uri, result.durationMs, result.peaks);
 *
 * Thread-safety: all methods are async and serialize naturally on the JS
 * event loop. Concurrent start() calls are no-ops if already recording.
 *
 * Metering:
 *   - Enabled via `isMeteringEnabled: true` passed to prepareToRecordAsync().
 *   - nativeRecorder.getStatus().metering returns the current dB level.
 *   - A 50 ms setInterval reads getStatus() and feeds samples to PeakBucketer.
 *   - subscribeToPeaks() throttles snapshot delivery to ~10 fps (100 ms).
 */

import {
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
} from "expo-audio";
import { File } from "expo-file-system";
import { PeakBucketer } from "./peak-bucketer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VoiceMemoResult {
  /** Local file URI suitable for passing to postVoiceMemo. */
  uri: string;
  /** Recording duration in milliseconds (client-side measurement). */
  durationMs: number;
  /** File size in bytes (stat from FileSystem). */
  sizeBytes: number;
  /**
   * Waveform peaks captured live during recording — exactly 80 normalized
   * values in [0, 1]. Suitable for direct use as the audioPeaks field in
   * the upload form (Phase 4 wires this to the backend).
   */
  peaks: number[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 10 minutes — hard cap matching server-side clamp. */
const MAX_DURATION_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Audio mode helpers — same as useServerVoiceInput
// ---------------------------------------------------------------------------

async function activateRecordingMode(): Promise<void> {
  await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
}

async function deactivateRecordingMode(): Promise<void> {
  await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: false });
}

// ---------------------------------------------------------------------------
// File cleanup helper
// ---------------------------------------------------------------------------

function deleteFile(uri: string | null | undefined): void {
  if (!uri) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // Best-effort.
  }
}

// ---------------------------------------------------------------------------
// Recorder class
// ---------------------------------------------------------------------------

/** How often (ms) to poll nativeRecorder.getStatus() for metering data. */
const METERING_POLL_MS = 50;

/** How often (ms) to push snapshot updates to subscribeToPeaks listeners (~10 fps). */
const PEAKS_EMIT_MS = 100;

/** dB floor — samples quieter than this are treated as silence (0). */
const METERING_FLOOR_DB = -60;

/**
 * Convert a dB meter value to linear amplitude in [0, 1].
 * Values below METERING_FLOOR_DB are clamped to 0.
 */
function dbToLinear(db: number): number {
  if (db < METERING_FLOOR_DB) return 0;
  return Math.min(1, Math.pow(10, db / 20));
}

/** Signature for subscribeToPeaks listeners. */
type PeaksListener = (peaks: number[]) => void;

/**
 * Stateful wrapper around an expo-audio recorder for voice memo capture.
 *
 * Instantiate once per MicButton mount; pass `audioRecorder` obtained from
 * `useAudioRecorder(RecordingPresets.HIGH_QUALITY)` so the underlying native
 * object is managed by the hook's lifecycle.
 */
export class VoiceMemoRecorder {
  private readonly nativeRecorder: ReturnType<typeof useAudioRecorder>;
  private startedAt: number | null = null;
  private cancelledFlag = false;

  // ---- peak capture state ----
  private bucketer: PeakBucketer | null = null;
  private meteringInterval: ReturnType<typeof setInterval> | null = null;
  private peaksEmitInterval: ReturnType<typeof setInterval> | null = null;
  private peaksListeners: Set<PeaksListener> = new Set();

  constructor(nativeRecorder: ReturnType<typeof useAudioRecorder>) {
    this.nativeRecorder = nativeRecorder;
  }

  /** Whether a recording session is currently in progress. */
  get isRecording(): boolean {
    return this.startedAt !== null;
  }

  /**
   * Begin recording into a temporary M4A file.
   *
   * Enables metering so getStatus().metering returns live dB values. A 50 ms
   * interval reads those values and feeds them to PeakBucketer. A second
   * 100 ms interval pushes waveform snapshots to subscribeToPeaks listeners.
   *
   * No-op if already recording. Caller must have requested microphone
   * permission before calling; VoiceMemoRecorder does not re-request.
   *
   * @throws If activating the audio session or the native recorder fails.
   */
  async start(): Promise<void> {
    if (this.startedAt !== null) return;

    this.cancelledFlag = false;
    this.bucketer = new PeakBucketer(80);

    await activateRecordingMode();
    // isMeteringEnabled makes getStatus().metering populate with live dB data.
    await this.nativeRecorder.prepareToRecordAsync({ isMeteringEnabled: true });
    this.nativeRecorder.record();
    this.startedAt = Date.now();

    // Poll metering at 50 ms cadence.
    this.meteringInterval = setInterval(() => {
      const status = this.nativeRecorder.getStatus();
      const db = status.metering;
      if (db !== undefined && this.bucketer !== null) {
        this.bucketer.push(dbToLinear(db));
      }
    }, METERING_POLL_MS);

    // Push snapshots to listeners at ~10 fps.
    this.peaksEmitInterval = setInterval(() => {
      if (this.bucketer === null || this.peaksListeners.size === 0) return;
      const peaks = this.bucketer.snapshot();
      this.peaksListeners.forEach((fn) => fn(peaks));
    }, PEAKS_EMIT_MS);
  }

  /** Stop the metering + emit intervals and clear them. */
  private _stopIntervals(): void {
    if (this.meteringInterval !== null) {
      clearInterval(this.meteringInterval);
      this.meteringInterval = null;
    }
    if (this.peaksEmitInterval !== null) {
      clearInterval(this.peaksEmitInterval);
      this.peaksEmitInterval = null;
    }
  }

  /**
   * Stop recording and return file metadata including the captured waveform.
   *
   * @returns File metadata on success, or `null` if `cancel()` was called
   *          before or during this call.
   */
  async stop(): Promise<VoiceMemoResult | null> {
    if (this.startedAt === null) return null;

    const elapsed = Date.now() - this.startedAt;
    this.startedAt = null;

    this._stopIntervals();

    await this.nativeRecorder.stop();
    await deactivateRecordingMode().catch(() => undefined);

    if (this.cancelledFlag) {
      deleteFile(this.nativeRecorder.uri);
      this.bucketer?.reset();
      this.bucketer = null;
      return null;
    }

    const uri = this.nativeRecorder.uri;
    if (!uri) {
      this.bucketer?.reset();
      this.bucketer = null;
      return null;
    }

    const peaks = this.bucketer?.finalize() ?? new Array<number>(80).fill(0);
    this.bucketer?.reset();
    this.bucketer = null;

    let sizeBytes = 0;
    try {
      const file = new File(uri);
      if (file.exists) sizeBytes = file.size ?? 0;
    } catch {
      // Non-fatal — send without size metadata.
    }

    return { uri, durationMs: Math.min(elapsed, MAX_DURATION_MS), sizeBytes, peaks };
  }

  /**
   * Abort the recording without uploading; the temp file is deleted and the
   * peak bucketer is reset.
   *
   * Safe to call concurrently with stop() — cancelledFlag causes stop() to
   * discard the result and return null.
   */
  async cancel(): Promise<void> {
    if (this.startedAt === null) return;

    this.cancelledFlag = true;
    this.startedAt = null;

    this._stopIntervals();
    this.bucketer?.reset();
    this.bucketer = null;

    try {
      await this.nativeRecorder.stop();
    } catch {
      // Ignore — we're discarding anyway.
    }
    deleteFile(this.nativeRecorder.uri);
    await deactivateRecordingMode().catch(() => undefined);
  }

  /**
   * Subscribe to live waveform snapshot updates (~10 fps).
   *
   * The listener is called with the current PeakBucketer snapshot on each
   * emit tick while recording is in progress. Snapshots have variable length
   * (growing up to 80) — the UI should scale its X-axis to fit.
   *
   * @param listener - Callback receiving the latest peaks array.
   * @returns Unsubscribe function. Call it when the subscribing component unmounts.
   */
  subscribeToPeaks(listener: PeaksListener): () => void {
    this.peaksListeners.add(listener);
    return () => {
      this.peaksListeners.delete(listener);
    };
  }
}
