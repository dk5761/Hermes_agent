/**
 * whisper-model-state — Zustand store tracking the lifecycle of the active
 * WhisperKit model variant (absent → downloading → ready | failed).
 *
 * Persisted in the SQLite KV store under `whisper.model.v1` so the last-used
 * model name survives app restarts.  Status is NOT persisted — it is resolved
 * on boot via `hydrate()`, which queries `WhisperKit.isModelDownloaded()`.
 *
 * Usage:
 *   // In _layout.tsx (boot):
 *   await useWhisperModelState.getState().hydrate();
 *
 *   // Before recording:
 *   await useWhisperModelState.getState().ensureReady();
 *
 *   // To show a progress bar:
 *   const { status, progress } = useWhisperModelState();
 */
import { Platform } from "react-native";
import * as FileSystem from "expo-file-system";
import { create } from "zustand";
import {
  WhisperKit,
  type WhisperModelDownloadProgressEvent,
  type WhisperModelName,
} from "whisperkit";
import { sqliteKv } from "@/state/sqlite-kv";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Lifecycle state of the active WhisperKit model. */
export type WhisperModelStatus = "absent" | "downloading" | "ready" | "failed";

export interface WhisperModelStateValues {
  /** Active model variant name. Default: `"openai_whisper-base.en"`. */
  activeModel: WhisperModelName;
  /** Current lifecycle status of the active model. */
  status: WhisperModelStatus;
  /**
   * Download progress in [0, 1].  Only meaningful while `status === "downloading"`.
   * Resets to 0 when a new download begins.
   */
  progress: number;
  /** Error description when `status === "failed"`, otherwise `null`. */
  errorMessage: string | null;
  /** True once `hydrate()` has completed at least once. */
  hydrated: boolean;
}

export interface WhisperModelStateActions {
  /**
   * Persist a new active model name and reset transient state.
   * Does NOT trigger a download — call `ensureReady()` when ready to proceed.
   */
  setActiveModel: (name: WhisperModelName) => void;

  /**
   * Idempotent — ensures the active model is downloaded and ready.
   *
   * - If status is "ready": resolves immediately.
   * - If status is "downloading": awaits the in-flight download.
   * - Otherwise: starts a new download, updating `progress` as it proceeds.
   *
   * Concurrent callers receive the same promise (deduped via module-level ref).
   */
  ensureReady: () => Promise<void>;

  /**
   * Hydrate store state from persisted settings and check on-device model
   * presence.  Safe to call multiple times (idempotent after first call).
   *
   * Should be called once from `_layout.tsx` on app boot.
   */
  hydrate: () => Promise<void>;

  /**
   * Reset status to "absent" and clear error/progress.  Does NOT delete the
   * model from disk or change the active model name.
   */
  reset: () => void;

  /**
   * Delete the active model's on-disk folder (if present), then immediately
   * call `ensureReady()` to trigger a fresh download.
   *
   * Shows the download progress UI while the new copy arrives.
   */
  forceRedownload: () => Promise<void>;

  /**
   * Delete the active model's on-disk folder and set status to "absent".
   * The next mic-button press will surface "model_not_ready" (Phase 4 handles it).
   */
  removeFromDevice: () => Promise<void>;
}

export type WhisperModelState = WhisperModelStateValues & WhisperModelStateActions;

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const STORAGE_KEY = "whisper.model.v1";
const DEFAULT_MODEL: WhisperModelName = "openai_whisper-base.en";

interface PersistedShape {
  activeModel?: string;
}

function parsePersisted(raw: string | null): PersistedShape {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === "object") return v as PersistedShape;
  } catch {
    // ignore
  }
  return {};
}

function persistModel(name: WhisperModelName): void {
  const payload: PersistedShape = { activeModel: name };
  void sqliteKv
    .setItem(STORAGE_KEY, JSON.stringify(payload))
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// In-flight deduplication
// ---------------------------------------------------------------------------

// Module-level ref so concurrent `ensureReady()` callers share one promise.
let ensureReadyInflight: Promise<void> | null = null;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useWhisperModelState = create<WhisperModelState>((set, get) => ({
  activeModel: DEFAULT_MODEL,
  status: "absent",
  progress: 0,
  errorMessage: null,
  hydrated: false,

  setActiveModel(name) {
    persistModel(name);
    set({ activeModel: name, status: "absent", progress: 0, errorMessage: null });
    // Clear any in-flight promise — the model changed so the old download is
    // no longer relevant.
    ensureReadyInflight = null;
  },

  ensureReady() {
    const state = get();

    if (state.status === "ready") {
      return Promise.resolve();
    }

    if (state.status === "downloading" && ensureReadyInflight !== null) {
      return ensureReadyInflight;
    }

    const modelName = state.activeModel;

    const doDownload = async (): Promise<void> => {
      set({ status: "downloading", progress: 0, errorMessage: null });

      // Subscribe to download progress events for the duration of the download.
      // Expo event subscriptions are synchronous so this is safe to set up
      // before calling ensureModel().
      let sub: ReturnType<typeof WhisperKit.addModelDownloadProgressListener> | null = null;

      if (Platform.OS === "ios") {
        sub = WhisperKit.addModelDownloadProgressListener(({ fraction }: WhisperModelDownloadProgressEvent) => {
          set({ progress: Math.max(0, Math.min(fraction, 1)) });
        });
      }

      try {
        if (Platform.OS === "ios") {
          await WhisperKit.ensureModel(modelName);
        }
        set({ status: "ready", progress: 1, errorMessage: null });
      } catch (err: unknown) {
        const msg =
          err instanceof Error ? err.message : "Download failed";
        set({ status: "failed", errorMessage: msg });
        throw err;
      } finally {
        sub?.remove();
        ensureReadyInflight = null;
      }
    };

    ensureReadyInflight = doDownload();
    return ensureReadyInflight;
  },

  async hydrate() {
    if (get().hydrated) return;

    // Load persisted model name.
    const raw = await sqliteKv.getItem(STORAGE_KEY);
    const persisted = parsePersisted(raw);
    const activeModel: WhisperModelName =
      isKnownModel(persisted.activeModel) ? persisted.activeModel : DEFAULT_MODEL;

    // Check whether the model is already on disk.
    let status: WhisperModelStatus = "absent";
    if (Platform.OS === "ios") {
      try {
        const downloaded = await WhisperKit.isModelDownloaded(activeModel);
        status = downloaded ? "ready" : "absent";
      } catch {
        // If the native call fails (e.g. module not loaded yet), stay "absent".
        status = "absent";
      }
    }

    set({ activeModel, status, hydrated: true, progress: 0, errorMessage: null });
  },

  reset() {
    ensureReadyInflight = null;
    set({ status: "absent", progress: 0, errorMessage: null });
  },

  async forceRedownload() {
    const { activeModel } = get();
    await deleteModelDir(activeModel);
    ensureReadyInflight = null;
    set({ status: "absent", progress: 0, errorMessage: null });
    await get().ensureReady();
  },

  async removeFromDevice() {
    const { activeModel } = get();
    await deleteModelDir(activeModel);
    ensureReadyInflight = null;
    set({ status: "absent", progress: 0, errorMessage: null });
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Delete the on-disk model folder for `modelName`, if it exists.
 * Silently no-ops if the folder is absent or the native call fails.
 * Uses `modelLocationOnDisk` to find the path rather than reconstructing it,
 * so the deletion stays aligned with wherever WhisperKit caches the files.
 */
async function deleteModelDir(modelName: WhisperModelName): Promise<void> {
  if (Platform.OS !== "ios") return;
  try {
    const path = await WhisperKit.modelLocationOnDisk(modelName);
    if (!path) return;
    const info = await FileSystem.getInfoAsync(path);
    if (info.exists) {
      await FileSystem.deleteAsync(path, { idempotent: true });
    }
  } catch {
    // Best-effort — ignore failures (e.g. file already gone).
  }
}

const KNOWN_MODELS = new Set<string>([
  "openai_whisper-tiny",
  "openai_whisper-tiny.en",
  "openai_whisper-base",
  "openai_whisper-base.en",
  "openai_whisper-small",
  "openai_whisper-small.en",
  "openai_whisper-medium",
  "openai_whisper-medium.en",
  "openai_whisper-large",
  "openai_whisper-large-v2",
  "openai_whisper-large-v3",
]);

function isKnownModel(name: string | undefined): name is WhisperModelName {
  return typeof name === "string" && KNOWN_MODELS.has(name);
}
