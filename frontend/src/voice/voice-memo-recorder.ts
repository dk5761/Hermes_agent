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
 *   if (result) upload(result.uri, result.durationMs);
 *
 * Thread-safety: all methods are async and serialize naturally on the JS
 * event loop. Concurrent start() calls are no-ops if already recording.
 */

import {
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
} from "expo-audio";
import { File } from "expo-file-system";

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
   * No-op if already recording. Caller must have requested microphone
   * permission before calling; VoiceMemoRecorder does not re-request.
   *
   * @throws If activating the audio session or the native recorder fails.
   */
  async start(): Promise<void> {
    if (this.startedAt !== null) return;

    this.cancelledFlag = false;

    await activateRecordingMode();
    await this.nativeRecorder.prepareToRecordAsync();
    this.nativeRecorder.record();
    this.startedAt = Date.now();
    // MicButton's own interval enforces the 10-min cap via the elapsed counter.
  }

  /**
   * Stop recording and return file metadata.
   *
   * @returns File metadata on success, or `null` if `cancel()` was called
   *          before or during this call.
   */
  async stop(): Promise<VoiceMemoResult | null> {
    if (this.startedAt === null) return null;

    const elapsed = Date.now() - this.startedAt;
    this.startedAt = null;

    await this.nativeRecorder.stop();
    await deactivateRecordingMode().catch(() => undefined);

    if (this.cancelledFlag) {
      deleteFile(this.nativeRecorder.uri);
      return null;
    }

    const uri = this.nativeRecorder.uri;
    if (!uri) return null;

    let sizeBytes = 0;
    try {
      const file = new File(uri);
      if (file.exists) sizeBytes = file.size ?? 0;
    } catch {
      // Non-fatal — send without size metadata.
    }

    return { uri, durationMs: Math.min(elapsed, MAX_DURATION_MS), sizeBytes };
  }

  /**
   * Abort the recording without uploading; the temp file is deleted.
   *
   * Safe to call concurrently with stop() — cancelledFlag causes stop() to
   * discard the result and return null.
   */
  async cancel(): Promise<void> {
    if (this.startedAt === null) return;

    this.cancelledFlag = true;
    this.startedAt = null;

    try {
      await this.nativeRecorder.stop();
    } catch {
      // Ignore — we're discarding anyway.
    }
    deleteFile(this.nativeRecorder.uri);
    await deactivateRecordingMode().catch(() => undefined);
  }
}
