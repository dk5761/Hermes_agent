import { Directory, File, Paths } from "expo-file-system";
import { API_URL } from "../config";

// Thumbnails live in the OS cache directory (eligible for system eviction).
// Signed URL fetches add a `?sig=&exp=` so we cannot rely on the URL as a
// stable cache key — use the attachment id instead.
const THUMBS_DIRNAME = "thumbs";

function thumbsDir(): Directory {
  const d = new Directory(Paths.cache, THUMBS_DIRNAME);
  // create() is idempotent here so it's safe to call on every miss.
  if (!d.exists) d.create({ idempotent: true, intermediates: true });
  return d;
}

function thumbFile(attachmentId: string): File {
  return new File(thumbsDir(), `${attachmentId}.jpg`);
}

// One in-flight download per attachment id — avoids double-fetching when the
// same thumbnail mounts from multiple bubbles concurrently.
const inflight = new Map<string, Promise<string | null>>();

async function resolveSignedUrl(
  attachmentId: string,
  accessToken: string,
): Promise<string | null> {
  // redirect:'manual' lets us pull the Location header without RN auto-following
  // and stripping our auth header on the second hop.
  const url = `${API_URL}/uploads/${encodeURIComponent(attachmentId)}/thumb`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
    redirect: "manual",
  });

  // Some RN platforms auto-follow regardless of `redirect:'manual'`. If we get
  // a 2xx with bytes back, treat the original URL as the source for download.
  if (res.status >= 200 && res.status < 300) {
    return url;
  }
  if (res.status === 301 || res.status === 302 || res.status === 307 || res.status === 308) {
    const loc = res.headers.get("location") ?? res.headers.get("Location");
    if (!loc) return null;
    if (loc.startsWith("http")) return loc;
    // Relative redirect — resolve against API base.
    if (loc.startsWith("/")) return `${API_URL}${loc}`;
    return `${API_URL}/${loc}`;
  }
  return null;
}

async function ensureThumbInner(
  attachmentId: string,
  accessToken: string,
): Promise<string | null> {
  const target = thumbFile(attachmentId);
  if (target.exists) return target.uri;

  const signed = await resolveSignedUrl(attachmentId, accessToken);
  if (!signed) return null;

  // If the URL is the auth-required gateway endpoint we still need the bearer
  // header during download; signed-url variants pass auth via query string.
  const headers: Record<string, string> = {};
  if (signed.startsWith(API_URL) && signed.includes("/uploads/")) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }

  try {
    const downloaded = await File.downloadFileAsync(signed, target, {
      headers,
      idempotent: true,
    });
    return downloaded.uri;
  } catch {
    // Cleanup partial file (downloadFileAsync is mostly atomic on iOS but be safe).
    try {
      if (target.exists) target.delete();
    } catch {
      // ignore
    }
    return null;
  }
}

export async function ensureThumb(
  attachmentId: string,
  accessToken: string | null,
): Promise<string | null> {
  if (!accessToken) return null;
  const existing = inflight.get(attachmentId);
  if (existing) return existing;
  const p = ensureThumbInner(attachmentId, accessToken).finally(() => {
    inflight.delete(attachmentId);
  });
  inflight.set(attachmentId, p);
  return p;
}

// Synchronous read of any cached file URI. Returns null if the file is missing.
export function getCachedThumbUri(attachmentId: string): string | null {
  const f = thumbFile(attachmentId);
  return f.exists ? f.uri : null;
}
