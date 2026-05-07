import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { extractAudioPeaks } from "../blobs/audio-peaks.js";
import type { AppLogger } from "../logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a successful TTS media extraction. */
export interface TtsMedia {
  absPath: string;
}

/** Blob relocation result. */
export interface RelocatedBlob {
  relKey: string;
  sha: string;
  durationMs: number;
  peaks: number[] | null;
}

// ---------------------------------------------------------------------------
// extractTtsMedia
// ---------------------------------------------------------------------------

/**
 * Inspect a `tool.complete` payload and extract the absolute Hermes-side path
 * of the generated audio file when this is a successful `text_to_speech` call.
 *
 * Expected payload shape:
 * ```json
 * {
 *   "name": "text_to_speech",
 *   "result": "{\"success\":true,\"file_path\":\"/opt/data/cache/audio/tts_...mp3\",\"media_tag\":\"MEDIA:/opt/data/...\",\"provider\":\"kokoro\",...}"
 * }
 * ```
 * `result` is a JSON-encoded string. `media_tag` may carry a
 * `[[audio_as_voice]]` prefix line — strip it before reading the path.
 *
 * @param payload  Raw `tool.complete` event payload (type unknown).
 * @returns Absolute Hermes-side path, or null if payload does not match.
 */
export function extractTtsMedia(payload: unknown): TtsMedia | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;

  if (p["name"] !== "text_to_speech") return null;

  const rawResult = p["result"];
  if (typeof rawResult !== "string") return null;

  let parsed: Record<string, unknown>;
  try {
    const r = JSON.parse(rawResult);
    if (!r || typeof r !== "object") return null;
    parsed = r as Record<string, unknown>;
  } catch {
    return null;
  }

  if (parsed["success"] !== true) return null;

  // Prefer `media_tag` — it includes the canonical path. Strip the optional
  // `[[audio_as_voice]]\n` prefix line that the TTS tool may prepend.
  const mediaTag = typeof parsed["media_tag"] === "string" ? parsed["media_tag"] : null;
  if (mediaTag) {
    const lines = mediaTag.split("\n");
    // The MEDIA: prefix line is the canonical one. Find it regardless of
    // whether the `[[audio_as_voice]]` annotation is present.
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("MEDIA:")) {
        const absPath = trimmed.slice("MEDIA:".length).trim();
        if (absPath) return { absPath };
      }
    }
  }

  // Fallback: file_path field in the result JSON.
  const filePath = parsed["file_path"];
  if (typeof filePath === "string" && filePath) {
    return { absPath: filePath };
  }

  return null;
}

// ---------------------------------------------------------------------------
// translateHermesPath
// ---------------------------------------------------------------------------

/** Hermes' internal container root on docker deployments. */
const HERMES_DOCKER_PREFIX = "/opt/data";

/** Hermes' home on VPS bare-metal deployments. */
const HERMES_VPS_PREFIX = "/root/.hermes";

/**
 * Translate a path written by Hermes into one that the gateway process can
 * read from the filesystem.
 *
 * Two well-known Hermes prefixes:
 * - `/opt/data/...` (docker container view): gateway has `hermesHomeMount`
 *   (`HERMES_HOME`, default `/data/hermes-home`) mounted at the same host
 *   path that Hermes writes `/opt/data/...` to. We remap the prefix.
 * - `/root/.hermes/...` (VPS bare-metal): gateway and Hermes share the same
 *   host filesystem; path passes through unchanged.
 *
 * If the path doesn't start with either known prefix, we check whether the
 * path already exists on the gateway's filesystem as-given (e.g. a custom
 * mount scenario) and return it unchanged if so. Returns null otherwise.
 *
 * @param absPath         Absolute path as written by Hermes.
 * @param hermesHomeMount Gateway's mount point for Hermes' home dir (`HERMES_HOME`).
 * @returns Accessible absolute path for the gateway, or null.
 */
export function translateHermesPath(absPath: string, hermesHomeMount: string): string | null {
  // Docker: /opt/data/cache/audio/x.mp3 → <hermesHomeMount>/cache/audio/x.mp3
  if (absPath.startsWith(HERMES_DOCKER_PREFIX + "/")) {
    const suffix = absPath.slice(HERMES_DOCKER_PREFIX.length); // keeps leading /
    return hermesHomeMount.replace(/\/$/, "") + suffix;
  }

  // VPS bare-metal: /root/.hermes/... → pass through when hermesHomeMount matches
  if (absPath.startsWith(HERMES_VPS_PREFIX + "/")) {
    if (hermesHomeMount === HERMES_VPS_PREFIX) {
      // Standard VPS config — gateway reads it directly.
      return absPath;
    }
    // hermesHomeMount is a different path (unusual). Remap by suffix anyway,
    // matching the same logic used for docker above.
    const suffix = absPath.slice(HERMES_VPS_PREFIX.length);
    return hermesHomeMount.replace(/\/$/, "") + suffix;
  }

  // Unknown prefix — return as-is; caller verifies accessibility.
  // (This covers edge cases like custom bind-mount paths.)
  return absPath;
}

// ---------------------------------------------------------------------------
// relocateTtsBlob
// ---------------------------------------------------------------------------

/**
 * Copy `srcAbs` into `<blobRoot>/voice/<sha256>.<ext>` with sha-based
 * deduplication, then extract waveform peaks.
 *
 * Peak resolution order:
 * 1. Sidecar `<srcAbs>.peaks.json` written by Phase C's Kokoro patch — free,
 *    no ffmpeg needed.
 * 2. `extractAudioPeaks` from `../blobs/audio-peaks.ts` — shared helper used
 *    by voice-memo uploads. Reused here rather than duplicated so ffmpeg tuning
 *    (bucket count, timeout, PCM decode params) stays in one place.
 *
 * Failure modes are non-throwing: any IO or ffmpeg error is logged as a warn
 * and causes the function to return null. The caller falls through to the
 * regular (audio-less) persist path.
 *
 * Duration is obtained from ffprobe via a lightweight JSON probe command. A
 * failure returns 0 rather than null so the blob is still stored.
 *
 * @param srcAbs   Absolute path to the TTS audio file on the gateway filesystem.
 * @param blobRoot Absolute path to the blob store root (STORAGE_LOCAL_ROOT).
 * @param log      Structured logger.
 * @returns Relocation result, or null if the blob could not be stored.
 */
export async function relocateTtsBlob(
  srcAbs: string,
  blobRoot: string,
  log: AppLogger,
): Promise<RelocatedBlob | null> {
  // Read source file.
  let srcBuffer: Buffer;
  try {
    srcBuffer = await fsp.readFile(srcAbs);
  } catch (err) {
    log.warn({ err, srcAbs }, "tts-bridge: cannot read source audio file");
    return null;
  }

  if (srcBuffer.byteLength === 0) {
    log.warn({ srcAbs }, "tts-bridge: source audio file is empty");
    return null;
  }

  const ext = path.extname(srcAbs).toLowerCase() || ".mp3";
  const sha = crypto.createHash("sha256").update(srcBuffer).digest("hex");
  const relKey = `voice/${sha}${ext}`;
  const destAbs = path.join(blobRoot, relKey);

  // Ensure voice/ directory exists and write the blob (sha-dedup).
  try {
    await fsp.mkdir(path.join(blobRoot, "voice"), { recursive: true });
    try {
      await fsp.access(destAbs);
      // File already present — sha-dedup, skip write.
    } catch {
      await fsp.writeFile(destAbs, srcBuffer);
    }
  } catch (err) {
    log.warn({ err, destAbs }, "tts-bridge: failed to write blob");
    return null;
  }

  // Resolve peaks: sidecar first, then ffmpeg.
  const peaks = await resolvePeaks(srcAbs, destAbs, log);

  // Resolve duration via ffprobe.
  const durationMs = await probeDurationMs(destAbs, log);

  return { relKey, sha, durationMs, peaks };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Try to read a `.peaks.json` sidecar written by the Kokoro Phase C patch.
 * Falls back to ffmpeg-based extraction via the shared `extractAudioPeaks`
 * helper if the sidecar is absent or invalid.
 *
 * Using `extractAudioPeaks` from `../blobs/audio-peaks.ts` (shared) rather
 * than duplicating the ffmpeg spawn logic keeps all ffmpeg tuning in one place.
 * The sidecar approach (Phase C) is preferred because it is zero-cost at
 * relay time — the peaks are computed during synthesis.
 *
 * @param srcAbs   Original Hermes-side path (sidecar lives alongside it).
 * @param destAbs  Gateway-side copy (used for ffmpeg fallback).
 * @param log      Structured logger.
 * @returns 80-element float[0..1] array, or null on failure.
 */
async function resolvePeaks(
  srcAbs: string,
  destAbs: string,
  log: AppLogger,
): Promise<number[] | null> {
  const sidecarPath = `${srcAbs}.peaks.json`;
  try {
    const raw = await fsp.readFile(sidecarPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.length === 80 &&
      parsed.every((v) => typeof v === "number" && isFinite(v))
    ) {
      log.info({ sidecarPath }, "tts-bridge: peaks from sidecar");
      return parsed as number[];
    }
    log.warn({ sidecarPath }, "tts-bridge: sidecar peaks malformed, falling back to ffmpeg");
  } catch {
    // Sidecar absent (expected until Phase C is deployed) or unreadable.
  }

  // Fallback: extract from the relocated blob using ffmpeg.
  const peaks = await extractAudioPeaks(destAbs).catch(() => null);
  if (peaks === null) {
    log.warn({ destAbs }, "tts-bridge: ffmpeg peak extraction failed; storing null peaks");
  } else {
    log.info({ destAbs, source: "ffmpeg" }, "tts-bridge: peaks via ffmpeg");
  }
  return peaks;
}

/**
 * Run ffprobe to get the duration of an audio file in milliseconds.
 *
 * Returns 0 on failure rather than null so the blob is still stored and the
 * audio is playable (client can derive duration from the audio element).
 *
 * @param absPath  Absolute path to the audio file.
 * @param log      Structured logger.
 * @returns Duration in milliseconds (integer), or 0 on failure.
 */
async function probeDurationMs(absPath: string, log: AppLogger): Promise<number> {
  const { spawn } = await import("node:child_process");
  return new Promise<number>((resolve) => {
    const chunks: Buffer[] = [];
    const proc = spawn(
      "ffprobe",
      [
        "-v", "quiet",
        "-print_format", "json",
        "-show_entries", "format=duration",
        absPath,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(0);
    }, 5_000);

    proc.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    proc.on("error", () => {
      clearTimeout(timer);
      log.warn({ absPath }, "tts-bridge: ffprobe spawn failed");
      resolve(0);
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        log.warn({ absPath, code }, "tts-bridge: ffprobe non-zero exit");
        resolve(0);
        return;
      }
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        const json = JSON.parse(text) as Record<string, unknown>;
        const fmt = json["format"] as Record<string, unknown> | undefined;
        const durStr = fmt?.["duration"];
        if (typeof durStr === "string") {
          const dur = parseFloat(durStr);
          if (isFinite(dur) && dur > 0) {
            resolve(Math.round(dur * 1000));
            return;
          }
        }
      } catch {
        // JSON parse failed
      }
      log.warn({ absPath }, "tts-bridge: ffprobe duration parse failed");
      resolve(0);
    });
  });
}
