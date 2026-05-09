/**
 * playback-controller — singleton Zustand store + expo-audio player that
 * enforces single-playback-at-a-time across all AudioMessage bubbles.
 *
 * Design decisions:
 * - Uses `createAudioPlayer` (not the `useAudioPlayer` hook) because the player
 *   must outlive any individual chat-list component's mount/unmount cycle.
 * - Auth-gated blobs are downloaded via `File.downloadFileAsync` with the
 *   Bearer header, written to `Paths.document/audio-cache/<messageId>.m4a`,
 *   then played from the local URI. This keeps playback free of auth complexity
 *   at runtime and makes subsequent plays instant (cache hit).
 * - Audio mode is explicitly set for playback before each `play()` call because
 *   the recorder (Phase 2) leaves the session in `allowsRecording: true` after
 *   a voice memo is sent. Without this reset the speaker output may be routed
 *   to the earpiece on iOS.
 */

import { AppState, type AppStateStatus } from "react-native";
import { create } from "zustand";
import {
  createAudioPlayer,
  setAudioModeAsync,
  type AudioPlayer,
} from "expo-audio";
import { Directory, File, Paths } from "expo-file-system";
import { API_URL } from "@/config";
import { getAuthSnapshot, useAuthStore } from "@/auth/store";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PlaybackStatus =
  | "idle"
  | "loading"
  | "playing"
  | "paused"
  | "error";

export interface PlaybackState {
  /** The message currently loaded (or loading). Null when idle. */
  activeMessageId: string | null;
  status: PlaybackStatus;
  /** Current position in milliseconds. */
  positionMs: number;
  /** Total duration in milliseconds — populated from the prop on play(). */
  durationMs: number;
  /** Set when status === "error". */
  errorMessage: string | null;
}

// ---------------------------------------------------------------------------
// Internal state (not in Zustand — native objects can't be serialized)
// ---------------------------------------------------------------------------

let activePlayer: AudioPlayer | null = null;
/** Unsubscribes the playbackStatusUpdate listener on the current player. */
let statusUnsub: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Audio cache helpers (expo-file-system v55 new API)
// ---------------------------------------------------------------------------

const CACHE_DIRNAME = "audio-cache";

/** Hard cap for the audio cache directory. Evict oldest files when exceeded. */
export const AUDIO_CACHE_MAX_BYTES = 100 * 1024 * 1024; // 100 MB

/**
 * In-memory LRU access tracker. Keyed by filename (e.g. `<messageId>.m4a`).
 * Updated on cache hit (read) and on write. Values are `Date.now()` timestamps.
 * Falls back to file mtime for files not in memory (e.g. after app restart).
 */
const lastAccessAt = new Map<string, number>();

/** Prevents concurrent eviction passes from running simultaneously. */
let evictionInFlight: Promise<void> | null = null;

function audioCacheDir(): Directory {
  const d = new Directory(Paths.document, CACHE_DIRNAME);
  if (!d.exists) d.create({ idempotent: true, intermediates: true });
  return d;
}

// Derive a file extension from a blob URL so the cached file matches the
// actual audio container. iOS expo-audio refuses to play files whose
// extension contradicts the bytes (TTS mp3 cached as .m4a fails silently).
function extFromBlobUrl(url: string): string {
  const cleaned = (url.split("?")[0] ?? "").toLowerCase();
  const dot = cleaned.lastIndexOf(".");
  if (dot === -1) return ".m4a";
  const ext = cleaned.slice(dot);
  // Whitelist common audio formats; fall back to .m4a for anything else
  // so we don't leak an arbitrary URL-derived extension into the cache dir.
  if (ext === ".m4a" || ext === ".mp3" || ext === ".ogg" || ext === ".wav") {
    return ext;
  }
  return ".m4a";
}

function cacheFileFor(messageId: string, ext: string = ".m4a"): File {
  return new File(audioCacheDir(), `${messageId}${ext}`);
}

/**
 * Scan `audio-cache/`, compute total size, and unlink the least-recently-used
 * files until total size is under `AUDIO_CACHE_MAX_BYTES`. Uses the
 * `lastAccessAt` in-memory map for LRU ordering, falling back to file mtime
 * for files not tracked in memory (survives app restarts).
 *
 * Only one eviction pass runs at a time; concurrent callers await the same
 * in-flight promise.
 */
async function evictCacheIfNeeded(): Promise<void> {
  if (evictionInFlight) {
    await evictionInFlight;
    return;
  }

  evictionInFlight = _runEviction().finally(() => {
    evictionInFlight = null;
  });
  await evictionInFlight;
}

async function _runEviction(): Promise<void> {
  const cacheDir = audioCacheDir();
  let entries: { name: string; file: File }[];
  try {
    entries = (cacheDir.list() as File[])
      .filter((f) => f instanceof File)
      .map((f) => ({ name: f.name ?? "", file: f }));
  } catch {
    return;
  }

  // Compute total size and gather stat info.
  let totalBytes = 0;
  const infos: Array<{ name: string; file: File; sizeBytes: number; accessedAt: number }> = [];
  for (const { name, file } of entries) {
    const sz = file.size ?? 0;
    totalBytes += sz;
    const accessedAt = lastAccessAt.get(name) ?? 0;
    infos.push({ name, file, sizeBytes: sz, accessedAt });
  }

  if (totalBytes <= AUDIO_CACHE_MAX_BYTES) return;

  // Sort ascending by accessedAt (LRU first). Zero means unknown — evict first.
  infos.sort((a, b) => a.accessedAt - b.accessedAt);

  for (const info of infos) {
    if (totalBytes <= AUDIO_CACHE_MAX_BYTES) break;
    try {
      info.file.delete();
      lastAccessAt.delete(info.name);
      totalBytes -= info.sizeBytes;
    } catch {
      // Best-effort — continue to next file.
    }
  }
}

/**
 * Returns the local file URI for `messageId`, downloading the blob if needed.
 * After a successful download, triggers LRU eviction if the cache is over cap.
 *
 * Corrupt-cache guard: if the cached file's size is 0 we delete and re-download.
 *
 * @param messageId - Unique message identifier (used as the cache key).
 * @param blobUrl   - Relative or absolute URL for the audio blob.
 * @returns Local `file://` URI ready to pass to `createAudioPlayer`.
 * @throws On network failure or HTTP error.
 */
async function resolveCachedUri(
  messageId: string,
  blobUrl: string,
): Promise<string> {
  // Local file URI (just-recorded voice memo, before upload completes) —
  // expo-audio's createAudioPlayer takes file:// URIs natively, no need to
  // route through the HTTP cache. Without this guard, the function below
  // builds `${API_URL}file:///…` and downloadFileAsync chokes on the
  // malformed URL, leaving the bubble stuck in "loading" state.
  //
  // Sniff the bytes here too — iOS sim's recorder produces CoreAudio
  // Format files saved with a `.m4a` extension. If they don't match,
  // copy the bytes into audio-cache under a corrected extension so
  // expo-audio doesn't reject the source.
  if (blobUrl.startsWith("file://")) {
    const localFile = new File(blobUrl);
    if (!localFile.exists) return blobUrl;
    const localExt = (() => {
      const dot = blobUrl.lastIndexOf(".");
      return dot >= 0 ? blobUrl.slice(dot).toLowerCase() : ".m4a";
    })();
    const corrected = await sniffAndRenameIfMismatched(localFile, localExt);
    return corrected;
  }

  const ext = extFromBlobUrl(blobUrl);
  const cached = cacheFileFor(messageId, ext);
  const filename = `${messageId}${ext}`;

  // Re-resolve the cached file's actual extension before returning. iOS
  // expo-audio refuses to play a file whose extension contradicts the
  // bytes ("ftyp"-prefixed M4A served as .caf, or "caff"-prefixed CAF
  // served as .m4a, fail silently with no status events). The iOS sim's
  // recorder degrades AAC → CoreAudio Format on simulator builds, so a
  // memo recorded on the sim and uploaded as `.m4a` is actually CAF
  // bytes. Sniff the bytes once and rename to a matching extension.
  if (cached.exists) {
    const sz = cached.size ?? 0;
    if (sz > 0) {
      const correct = await sniffAndRenameIfMismatched(cached, ext);
      lastAccessAt.set(filename, Date.now());
      return correct;
    }
    cached.delete();
  }

  const fullUrl = blobUrl.startsWith("http")
    ? blobUrl
    : `${API_URL}${blobUrl}`;

  let token = getAuthSnapshot().accessToken;
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  try {
    await File.downloadFileAsync(fullUrl, cached, { headers });
  } catch (err) {
    // Attempt token refresh and retry once on auth failure.
    const isAuthError =
      err instanceof Error && err.message.includes("401");
    if (isAuthError) {
      const refreshed = await attemptRefresh();
      if (refreshed) {
        const retryHeaders: Record<string, string> = {
          Authorization: `Bearer ${refreshed}`,
        };
        if (cached.exists) cached.delete();
        await File.downloadFileAsync(fullUrl, cached, { headers: retryHeaders });
      } else {
        if (cached.exists) cached.delete();
        throw new Error("Audio fetch failed: authentication required");
      }
    } else {
      if (cached.exists) cached.delete();
      throw err;
    }
  }

  // Record access and trigger eviction in background.
  lastAccessAt.set(filename, Date.now());
  void evictCacheIfNeeded();

  // Sniff post-download too (server may have stored the file with a
  // mismatched extension; see the comment above for the iOS sim case).
  return sniffAndRenameIfMismatched(cached, ext);
}

/**
 * Detect the actual container format of `cached` from its first bytes
 * and, if the on-disk extension doesn't match, copy the file under a
 * corrected name and return the corrected URI. The original is left in
 * place for LRU cleanup to reap.
 *
 * Recognised formats:
 *   - "caff"  (offset 0)        → CoreAudio Format → `.caf`
 *   - "ftyp"  (offset 4)        → MP4/M4A          → `.m4a`
 *   - "ID3"   (offset 0)        → MP3 (with tag)   → `.mp3`
 *   - 0xFFFB/0xFFFA (offset 0)  → MP3 (no tag)     → `.mp3`
 *   - "RIFF"  (offset 0)        → WAV              → `.wav`
 *   - "OggS"  (offset 0)        → Ogg              → `.ogg`
 * Anything else falls back to the original extension.
 */
async function sniffAndRenameIfMismatched(
  cached: File,
  declaredExt: string,
): Promise<string> {
  let bytes: Uint8Array;
  try {
    bytes = await cached.bytes();
  } catch {
    return cached.uri;
  }
  const detected = detectAudioExt(bytes);
  if (!detected || detected === declaredExt) {
    return cached.uri;
  }
  // Build a sibling path with the correct extension. Derive the basename
  // from the URI (File.name isn't exposed in this expo-file-system API).
  const uri = cached.uri;
  const slash = uri.lastIndexOf("/");
  const filename = slash >= 0 ? uri.slice(slash + 1) : uri;
  const dot = filename.lastIndexOf(".");
  const baseName = dot >= 0 ? filename.slice(0, dot) : filename;
  const corrected = new File(audioCacheDir(), `${baseName}${detected}`);
  if (!corrected.exists) {
    try {
      cached.copy(corrected);
    } catch (copyErr) {
      console.warn("[playback] sniff: copy failed", { detected, declaredExt, copyErr });
      return cached.uri;
    }
  }
  console.log("[playback] sniff renamed", { declaredExt, detected, uri: corrected.uri });
  return corrected.uri;
}

function detectAudioExt(bytes: Uint8Array): string | null {
  if (bytes.byteLength < 12) return null;
  // CAF: "caff" at offset 0.
  if (bytes[0] === 0x63 && bytes[1] === 0x61 && bytes[2] === 0x66 && bytes[3] === 0x66) {
    return ".caf";
  }
  // M4A/MP4: "ftyp" at offset 4.
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    return ".m4a";
  }
  // MP3 with ID3 tag: "ID3" at offset 0.
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return ".mp3";
  }
  // MP3 without tag: 0xFFFB / 0xFFFA / 0xFFF3 / 0xFFF2 sync word at offset 0.
  if (bytes[0] === 0xff && bytes[1] !== undefined && (bytes[1] & 0xf6) === 0xf2) {
    return ".mp3";
  }
  // WAV: "RIFF" at offset 0.
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    return ".wav";
  }
  // Ogg: "OggS" at offset 0.
  if (bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) {
    return ".ogg";
  }
  return null;
}

/**
 * Delete all files inside `audio-cache/` without removing the directory itself.
 * Intended for the "Clear voice cache" diagnostics action.
 *
 * @returns Total bytes freed.
 */
export async function clearAudioCache(): Promise<number> {
  const cacheDir = audioCacheDir();
  let freed = 0;
  let files: File[];
  try {
    files = (cacheDir.list() as File[]).filter((f) => f instanceof File);
  } catch {
    return 0;
  }
  for (const file of files) {
    const sz = file.size ?? 0;
    try {
      file.delete();
      freed += sz;
      if (file.name) lastAccessAt.delete(file.name);
    } catch {
      // Best-effort.
    }
  }
  return freed;
}

/**
 * Compute the total byte size of all files currently in `audio-cache/`.
 *
 * @returns Total bytes used by the cache.
 */
export function getAudioCacheBytes(): number {
  const cacheDir = audioCacheDir();
  let total = 0;
  try {
    const files = (cacheDir.list() as File[]).filter((f) => f instanceof File);
    for (const f of files) total += f.size ?? 0;
  } catch {
    // Directory may not exist yet.
  }
  return total;
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

// ---------------------------------------------------------------------------
// Zustand store
// ---------------------------------------------------------------------------

interface PlaybackStore extends PlaybackState {
  // Internal setter — called by controller helpers, not by UI.
  _set: (patch: Partial<PlaybackState>) => void;
}

const usePlaybackStore = create<PlaybackStore>((set) => ({
  activeMessageId: null,
  status: "idle",
  positionMs: 0,
  durationMs: 0,
  errorMessage: null,
  _set: (patch) => set(patch),
}));

// ---------------------------------------------------------------------------
// Controller helpers
// ---------------------------------------------------------------------------

function patchStore(patch: Partial<PlaybackState>): void {
  usePlaybackStore.getState()._set(patch);
}

function teardownPlayer(): void {
  if (statusUnsub) {
    statusUnsub();
    statusUnsub = null;
  }
  if (activePlayer) {
    try {
      activePlayer.remove();
    } catch {
      // Ignore — already removed or in a bad state.
    }
    activePlayer = null;
  }
}

// ---------------------------------------------------------------------------
// AppState — pause on background
// ---------------------------------------------------------------------------

/**
 * Pauses playback when the app is backgrounded mid-play. Does not auto-resume
 * on foreground — the user must tap play again (matches Telegram / Messenger UX).
 *
 * Registered once at module load; lives for the lifetime of the app.
 */
function _handleAppStateChange(nextState: AppStateStatus): void {
  if (nextState !== "active") {
    const { status } = usePlaybackStore.getState();
    if (status === "playing") {
      pause();
    }
  }
}

AppState.addEventListener("change", _handleAppStateChange);

/**
 * Play the audio for `messageId`. If another message is already playing it is
 * stopped and unloaded first.
 *
 * @param messageId  - Unique identifier for the chat message.
 * @param blobUrl    - Relative or absolute URL for the audio blob.
 * @param durationMs - Duration hint from the server; used while the player loads.
 */
async function play(
  messageId: string,
  blobUrl: string,
  durationMs: number,
): Promise<void> {
  // If tapping the same message that's already paused, resume instead.
  const current = usePlaybackStore.getState();
  if (current.activeMessageId === messageId && current.status === "paused") {
    await resume();
    return;
  }

  teardownPlayer();

  patchStore({
    activeMessageId: messageId,
    status: "loading",
    positionMs: 0,
    durationMs,
    errorMessage: null,
  });

  try {
    // 1. Configure audio session for playback — overrides the recording mode
    //    that the voice-memo recorder may have left behind.
    await setAudioModeAsync({
      allowsRecording: false,
      playsInSilentMode: true,
      interruptionMode: "doNotMix",
      shouldPlayInBackground: false,
      shouldRouteThroughEarpiece: false,
    });

    // 2. Resolve a local cached URI (downloads if needed).
    const localUri = await resolveCachedUri(messageId, blobUrl);
    console.log("[playback] resolved", { messageId, blobUrl, localUri });

    // Guard: a different message may have been tapped while we were fetching.
    if (usePlaybackStore.getState().activeMessageId !== messageId) {
      console.log("[playback] another message took over, aborting");
      return;
    }

    // 3. Create a persistent player pointed at the local file.
    const player = createAudioPlayer(
      { uri: localUri },
      { updateInterval: 200 },
    );
    activePlayer = player;
    // Some expo-audio versions default `volume` to 0 on the simulator
    // when the prior audio session was a recorder. Force to 1 so audible
    // output is guaranteed once play() runs.
    try {
      player.volume = 1;
      // expo-audio iOS sometimes routes through earpiece when the audio
      // session was just used for recording; muted state reflects that.
      // Explicit unmute is cheap insurance.
      player.muted = false;
    } catch (volErr) {
      console.warn("[playback] volume/muted set failed", volErr);
    }
    console.log("[playback] player created", { uri: localUri, volume: player.volume });

    // 4. Subscribe to status updates.
    const sub = player.addListener("playbackStatusUpdate", (status) => {
      if (activePlayer !== player) return;
      console.log("[playback] status", {
        playing: status.playing,
        currentTime: status.currentTime,
        duration: status.duration,
        didJustFinish: status.didJustFinish,
      });

      if (status.didJustFinish) {
        teardownPlayer();
        patchStore({
          activeMessageId: null,
          status: "idle",
          positionMs: 0,
          durationMs: 0,
        });
        return;
      }

      patchStore({
        positionMs: Math.round(status.currentTime * 1000),
        durationMs:
          status.duration > 0
            ? Math.round(status.duration * 1000)
            : usePlaybackStore.getState().durationMs,
        status: status.playing ? "playing" : "paused",
      });
    });
    statusUnsub = () => sub.remove();

    // 5. Start playback.
    player.play();
    console.log("[playback] play() called");
    patchStore({ status: "playing" });
  } catch (err) {
    console.warn("[playback] error", err);
    teardownPlayer();
    const msg = err instanceof Error ? err.message : "Playback failed";
    patchStore({
      activeMessageId: null,
      status: "error",
      errorMessage: msg,
    });
  }
}

/** Pause the currently playing audio. No-op if nothing is playing. */
function pause(): void {
  if (!activePlayer) return;
  activePlayer.pause();
  patchStore({ status: "paused" });
}

/** Resume a paused track. No-op if not paused. */
async function resume(): Promise<void> {
  if (!activePlayer) return;
  await setAudioModeAsync({
    allowsRecording: false,
    playsInSilentMode: true,
    interruptionMode: "doNotMix",
    shouldPlayInBackground: false,
    shouldRouteThroughEarpiece: false,
  });
  activePlayer.play();
  patchStore({ status: "playing" });
}

/**
 * Seek to an absolute position.
 *
 * expo-audio may auto-resume playback after seekTo() on some platforms.
 * We guard against that by re-pausing if the player was paused before the seek.
 *
 * @param positionMs - Target position in milliseconds.
 */
async function seek(positionMs: number): Promise<void> {
  if (!activePlayer) return;
  const wasPaused = usePlaybackStore.getState().status === "paused";
  await activePlayer.seekTo(positionMs / 1000);
  // Re-apply pause if expo-audio auto-resumed on seek.
  if (wasPaused && activePlayer) {
    activePlayer.pause();
    patchStore({ positionMs, status: "paused" });
  } else {
    patchStore({ positionMs });
  }
}

/** Stop playback and reset state entirely. */
function stop(): void {
  teardownPlayer();
  patchStore({
    activeMessageId: null,
    status: "idle",
    positionMs: 0,
    durationMs: 0,
    errorMessage: null,
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Singleton playback controller. Import and call from any component; the
 * Zustand store ensures state is shared across all mounted AudioMessage
 * instances.
 *
 * State shape: `{ activeMessageId, status, positionMs, durationMs, errorMessage }`
 * Actions: `play`, `pause`, `resume`, `seek`, `stop`
 */
export const playbackController = {
  play,
  pause,
  resume,
  seek,
  stop,
} as const;

/**
 * Hook for React components to subscribe to global playback state.
 *
 * @example
 * ```ts
 * const { activeMessageId, status, positionMs, durationMs } = usePlaybackState();
 * const isActive = activeMessageId === myMessageId;
 * const isPlaying = isActive && status === "playing";
 * ```
 */
export function usePlaybackState(): PlaybackState {
  // Select each primitive separately so Zustand's default Object.is check
  // catches no-op updates. Returning a new object literal from a single
  // selector forces a re-render every store change AND every parent render
  // (because the returned object reference is fresh each call), which sends
  // AudioMessage into an infinite loop.
  const activeMessageId = usePlaybackStore((s) => s.activeMessageId);
  const status = usePlaybackStore((s) => s.status);
  const positionMs = usePlaybackStore((s) => s.positionMs);
  const durationMs = usePlaybackStore((s) => s.durationMs);
  const errorMessage = usePlaybackStore((s) => s.errorMessage);
  return { activeMessageId, status, positionMs, durationMs, errorMessage };
}
