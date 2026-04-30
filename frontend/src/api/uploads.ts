import { API_URL } from "../config";
import { getAuthSnapshot, useAuthStore } from "../auth/store";
import { ApiError } from "./types";
import type { AttachmentDTO, AttachmentKind } from "./types";
import type { LocalFileInput } from "../attachments/types";

// Multipart upload to /uploads. The shared apiFetch wrapper JSON-encodes the
// body, which is incompatible with FormData; this file mirrors its 401-refresh
// behavior locally so the rest of the app sees consistent auth handling.

let inflightRefresh: Promise<string | null> | null = null;

async function attemptRefresh(): Promise<string | null> {
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = (async () => {
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
    } finally {
      inflightRefresh = null;
    }
  })();
  return inflightRefresh;
}

function isAttachmentDTO(v: unknown): v is AttachmentDTO {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o["id"] !== "string") return false;
  const kind = o["kind"];
  if (kind !== "image" && kind !== "pdf" && kind !== "file") return false;
  if (typeof o["mime"] !== "string") return false;
  if (typeof o["sizeBytes"] !== "number") return false;
  if (typeof o["sha256"] !== "string") return false;
  if (typeof o["createdAt"] !== "number") return false;
  if (typeof o["hasThumb"] !== "boolean") return false;
  // originalName/extractedTextPreview may be null.
  return true;
}

export interface UploadOptions {
  appSessionId?: string;
  signal?: AbortSignal;
}

// React Native FormData accepts {uri, name, type} objects; we rely on the RN
// runtime to stream the file bytes from disk. Don't read them into memory.
interface RNFormDataFile {
  uri: string;
  name: string;
  type: string;
}

function buildForm(input: LocalFileInput, appSessionId?: string): FormData {
  const fd = new FormData();
  const filePart: RNFormDataFile = {
    uri: input.uri,
    name: input.name,
    type: input.mime,
  };
  // The RN typings for FormData.append don't include the {uri,name,type} variant.
  (fd as unknown as { append: (k: string, v: unknown) => void }).append(
    "file",
    filePart,
  );
  if (appSessionId) {
    fd.append("app_session_id", appSessionId);
  }
  return fd;
}

async function postOnce(
  form: FormData,
  token: string | null,
  signal: AbortSignal | undefined,
): Promise<Response> {
  // Don't set Content-Type — the platform sets it with the multipart boundary.
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return fetch(`${API_URL}/uploads`, {
    method: "POST",
    headers,
    body: form,
    signal,
  });
}

export async function uploadFile(
  input: LocalFileInput,
  opts: UploadOptions = {},
): Promise<AttachmentDTO> {
  const form = buildForm(input, opts.appSessionId);
  let token = getAuthSnapshot().accessToken;
  let res = await postOnce(form, token, opts.signal);

  if (res.status === 401) {
    const refreshed = await attemptRefresh();
    if (!refreshed) {
      await useAuthStore.getState().clear();
      throw new ApiError(401, "Session expired");
    }
    // FormData can be re-used in RN — but rebuild defensively to avoid
    // stream-already-read issues on some platforms.
    const form2 = buildForm(input, opts.appSessionId);
    res = await postOnce(form2, refreshed, opts.signal);
  }

  if (!res.ok) {
    let body: string;
    try {
      body = await res.text();
    } catch {
      body = res.statusText;
    }
    throw new ApiError(res.status, body || res.statusText);
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new ApiError(500, "Invalid upload response");
  }
  if (!isAttachmentDTO(parsed)) {
    throw new ApiError(500, "Malformed attachment response");
  }
  return parsed;
}

// Fetch metadata (used by chat history hydration when only the id is known).
// Unused by Phase 4 composer flow but exposed for future surfaces.
export async function getAttachment(id: string): Promise<AttachmentDTO> {
  let token = getAuthSnapshot().accessToken;
  const send = async (t: string | null): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (t) headers["Authorization"] = `Bearer ${t}`;
    return fetch(`${API_URL}/uploads/${encodeURIComponent(id)}`, {
      method: "GET",
      headers,
    });
  };
  let res = await send(token);
  if (res.status === 401) {
    const refreshed = await attemptRefresh();
    if (!refreshed) throw new ApiError(401, "Session expired");
    res = await send(refreshed);
  }
  if (!res.ok) throw new ApiError(res.status, await res.text());
  const parsed: unknown = await res.json();
  if (!isAttachmentDTO(parsed)) throw new ApiError(500, "Malformed attachment");
  return parsed;
}

export type { AttachmentKind };
