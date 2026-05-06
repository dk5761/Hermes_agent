/**
 * Thin client for the server STT endpoint.
 *
 * POST /sessions/:id/transcribe
 *   Body: multipart/form-data, field "audio" → binary M4A.
 *   Auth: Bearer (refreshed automatically on 401).
 *   Response: { transcript: string; provider: string; durationMs: number }
 *
 * Error handling: throws {@link TranscribeError} on any non-2xx response so
 * callers can map to the `server_stt_failed` VoiceInputError kind.
 *
 * Mirrors the multipart pattern in uploads.ts — apiFetch JSON-encodes bodies
 * so we build the fetch call manually here. Same 401-refresh logic is inlined
 * to keep the dependency surface minimal.
 */

import { API_URL } from "../config";
import { getAuthSnapshot, useAuthStore } from "../auth/store";

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

export interface TranscribeResponse {
  transcript: string;
  provider: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Typed error — carries the HTTP status so callers can distinguish
// 413 (too_large), 503 (stt_failed), 504 (stt_timeout), etc.
// ---------------------------------------------------------------------------

export class TranscribeError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TranscribeError";
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

// React Native FormData accepts {uri, name, type} objects; the RN runtime
// streams bytes from disk without loading them into JS memory.
interface RNFormDataFile {
  uri: string;
  name: string;
  type: string;
}

function buildForm(fileUri: string, mime: string): FormData {
  const fd = new FormData();
  const filePart: RNFormDataFile = { uri: fileUri, name: "recording.m4a", type: mime };
  // RN typings don't include the {uri,name,type} variant of FormData.append.
  (fd as unknown as { append: (k: string, v: unknown) => void }).append(
    "audio",
    filePart,
  );
  return fd;
}

async function postOnce(
  sessionId: string,
  form: FormData,
  token: string | null,
): Promise<Response> {
  // Don't set Content-Type — the platform fills it with the multipart boundary.
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return fetch(`${API_URL}/sessions/${encodeURIComponent(sessionId)}/transcribe`, {
    method: "POST",
    headers,
    body: form,
  });
}

async function attemptRefresh(): Promise<string | null> {
  const { refreshToken } = getAuthSnapshot();
  if (!refreshToken) return null;
  try {
    const res = await fetch(`${API_URL}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { accessToken?: string };
    if (!data.accessToken) return null;
    await useAuthStore.getState().setAccessToken(data.accessToken);
    return data.accessToken;
  } catch {
    return null;
  }
}

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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Upload a local audio file to the Hermes gateway STT endpoint.
 *
 * @param sessionId - Active app session ID (used as path param on the gateway).
 * @param fileUri   - Local file URI returned by `Audio.Recording.getURI()`.
 * @param mime      - MIME type, typically `"audio/m4a"`.
 * @returns Parsed transcript, provider name, and round-trip duration in ms.
 * @throws {TranscribeError} on non-2xx responses; status code is preserved.
 */
export async function postTranscribe(
  sessionId: string,
  fileUri: string,
  mime: string,
): Promise<TranscribeResponse> {
  let token = getAuthSnapshot().accessToken;
  let form = buildForm(fileUri, mime);
  let res = await postOnce(sessionId, form, token);

  if (res.status === 401) {
    const refreshed = await attemptRefresh();
    if (!refreshed) {
      await useAuthStore.getState().clear();
      throw new TranscribeError(401, "Session expired");
    }
    // Rebuild form — some platforms can't re-read an already-consumed FormData.
    form = buildForm(fileUri, mime);
    res = await postOnce(sessionId, form, refreshed);
  }

  if (!res.ok) {
    const message = await parseErrorMessage(res);
    throw new TranscribeError(res.status, message);
  }

  const data = (await res.json()) as TranscribeResponse;
  return data;
}
