/**
 * Typed client for the voice memo endpoints.
 *
 * POST /sessions/:id/messages/voice
 *   Body: multipart/form-data
 *     audio        — binary M4A (≤10 MB)
 *     audioDurationMs — string representation of duration in ms (optional)
 *   Auth: Bearer (refreshed automatically on 401).
 *   Response: { message: VoiceMemoMessage }
 *
 * POST /sessions/:id/messages/:msgId/retry-transcription
 *   Body: none
 *   Response: { message: VoiceMemoMessage }
 *
 * Follows the same multipart pattern as transcribe.ts — apiFetch JSON-encodes
 * bodies, so multipart calls are built manually with fetch() + refresh logic.
 *
 * Client-side timeout: 35 s. The server's STT deadline is ~30 s; we give 5 s
 * of extra headroom for network latency before aborting the upload ourselves.
 */

import { API_URL } from "../config";
import { getAuthSnapshot, useAuthStore } from "../auth/store";
import { attemptRefresh } from "./client";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Transcription lifecycle status values mirroring the backend enum. */
export type TranscriptionStatus = "transcribing" | "completed" | "failed";

/**
 * Voice memo message envelope returned by POST .../voice and
 * POST .../retry-transcription. Fields are a subset of the chat_history row
 * with camelCase names as serialised by the gateway.
 */
export interface VoiceMemoMessage {
  id: number;
  role: "user";
  /** STT transcript, or empty string while transcription is in flight. */
  content: string;
  /**
   * Relative URL path like `/voice-blobs/voice/<sha>.m4a`. Callers must
   * prefix with the gateway base URL (API_URL) before passing to the audio
   * player or fetch().
   */
  audioBlobUrl: string;
  audioDurationMs: number;
  transcriptionStatus: TranscriptionStatus;
  /** Populated only when transcriptionStatus === "failed". */
  transcriptionError?: string;
  /** Unix timestamp in seconds. */
  createdAt: number;
  /** Waveform data: 80 normalized floats (0..1). Null for old memos or failed extraction. */
  audioPeaks?: number[] | null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown on any non-2xx response from the voice memo endpoints. */
export class VoiceMemoError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "VoiceMemoError";
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** 35 s client-side timeout (server STT deadline is ~30 s). */
const UPLOAD_TIMEOUT_MS = 35_000;

async function parseErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? res.statusText;
  } catch {
    try {
      return await res.text();
    } catch {
      return res.statusText;
    }
  }
}

function buildVoiceForm(fileUri: string, durationMs: number, peaks?: number[]): FormData {
  const fd = new FormData();
  // React Native's FormData accepts {uri,name,type} for streaming file reads.
  // The standard TS typings omit this RN-specific overload, hence the cast.
  fd.append("audio", {
    uri: fileUri,
    name: "memo.m4a",
    type: "audio/m4a",
  } as unknown as Blob);
  fd.append("audioDurationMs", String(durationMs));
  // Server prefers client peaks over ffmpeg extraction when valid (Phase 3).
  if (peaks && peaks.length > 0) {
    fd.append("audioPeaks", JSON.stringify(peaks));
  }
  return fd;
}

async function postOnce(
  url: string,
  body: FormData | null,
  token: string | null,
  signal: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return fetch(url, {
    method: "POST",
    headers,
    body: body ?? undefined,
    signal,
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Upload a voice memo file to the Hermes gateway.
 *
 * The server stores the blob, runs STT, inserts a chat_history row, and
 * forwards the transcript to the Hermes agent. The response reflects the row
 * immediately after insertion — `transcriptionStatus` may be "transcribing"
 * if STT is asynchronous on the server side.
 *
 * @param sessionId - Active app session ID.
 * @param fileUri   - Local file URI from VoiceMemoRecorder.stop().
 * @param durationMs - Client-side recording duration in milliseconds.
 * @param peaks     - Optional client-captured waveform (80 values, 0..1).
 *                    When valid, the backend skips ffmpeg extraction.
 * @returns The newly created voice memo message.
 * @throws {VoiceMemoError} on non-2xx responses or timeout.
 */
export async function postVoiceMemo(
  sessionId: string,
  fileUri: string,
  durationMs: number,
  peaks?: number[],
): Promise<VoiceMemoMessage> {
  const url = `${API_URL}/sessions/${encodeURIComponent(sessionId)}/messages/voice`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

  try {
    let token = getAuthSnapshot().accessToken;
    let form = buildVoiceForm(fileUri, durationMs, peaks);
    let res = await postOnce(url, form, token, controller.signal);

    if (res.status === 401) {
      const refreshed = await attemptRefresh();
      if (!refreshed) {
        await useAuthStore.getState().clear();
        throw new VoiceMemoError(401, "Session expired");
      }
      // Rebuild form — some platforms can't re-read a consumed FormData.
      form = buildVoiceForm(fileUri, durationMs, peaks);
      res = await postOnce(url, form, refreshed, controller.signal);
    }

    if (!res.ok) {
      const message = await parseErrorMessage(res);
      throw new VoiceMemoError(res.status, message);
    }

    const data = (await res.json()) as { message: VoiceMemoMessage };
    return data.message;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Retry transcription for a voice memo whose previous STT attempt failed.
 *
 * Only valid when the target message has `transcriptionStatus === "failed"`.
 * On success the gateway re-runs STT, updates the row in place, and forwards
 * the new transcript to Hermes as a fresh user prompt.
 *
 * @param sessionId - Active app session ID.
 * @param msgId     - String form of the chat_history row id to retry.
 * @returns Updated voice memo message with the new transcription result.
 * @throws {VoiceMemoError} on non-2xx responses.
 */
export async function retryTranscription(
  sessionId: string,
  msgId: string,
): Promise<VoiceMemoMessage> {
  const url = `${API_URL}/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(msgId)}/retry-transcription`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

  try {
    let token = getAuthSnapshot().accessToken;
    let res = await postOnce(url, null, token, controller.signal);

    if (res.status === 401) {
      const refreshed = await attemptRefresh();
      if (!refreshed) {
        await useAuthStore.getState().clear();
        throw new VoiceMemoError(401, "Session expired");
      }
      res = await postOnce(url, null, refreshed, controller.signal);
    }

    if (!res.ok) {
      const message = await parseErrorMessage(res);
      throw new VoiceMemoError(res.status, message);
    }

    const data = (await res.json()) as { message: VoiceMemoMessage };
    return data.message;
  } finally {
    clearTimeout(timeout);
  }
}
