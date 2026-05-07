/**
 * Voice settings store — Zustand + SQLite persistence.
 *
 * Persists seven preferences:
 *   enabled            — whether voice input is surfaced at all
 *   language           — null means "use device locale"; otherwise a BCP-47 tag
 *   addsPunctuation    — Apple's auto-punctuation (SFSpeechRecognitionRequest).
 *                        Only meaningful when the SFSpeech engine is active.
 *   engine             — "auto" | "whisper" | "sfspeech" | "server". Default "auto".
 *                        "auto" resolves at start() time based on WhisperKit model
 *                        readiness (see resolveEngine in useVoiceInput).
 *   localCapSeconds    — hard-stop for whisper/sfspeech engines (default 60, range 30–180).
 *                        At cap: stop() is called so captured audio is delivered.
 *   serverCapSeconds   — hard-stop for the server engine (default 300, range 60–600).
 *   fallbackOnOffline  — when true and engine="server" + offline, resolve to an on-device
 *                        engine instead of surfacing a blocked error. Default true.
 *
 * Gesture behaviour is hardcoded (not persisted):
 *   tap  → toggle (start transcribing / stop transcribing)
 *   hold → voice memo (record while held, send on release; slide-to-cancel)
 *
 * Pattern matches the other stores in this directory (notifications-inbox,
 * todos, pinned-sessions): create() with a plain hydrate() that reads from
 * sqliteKv, and a persist() helper that writes back on every mutation.
 *
 * Hydration is non-blocking — called from app/_layout.tsx alongside the
 * other stores. Reads against a non-hydrated store return defaults.
 */
import { create } from "zustand";
import { sqliteKv } from "@/state/sqlite-kv";

const KEY = "voice.settings.v1";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Which speech recognition engine to use. */
export type VoiceEngine = "auto" | "whisper" | "sfspeech" | "server";

export interface VoiceSettings {
  enabled: boolean;
  /**
   * null = use device locale (resolved at runtime via Intl API).
   * Otherwise a BCP-47 locale tag e.g. "en-US", "es-ES".
   */
  language: string | null;
  /** Apple's auto-punctuation. Only meaningful when SFSpeech engine is active. */
  addsPunctuation: boolean;
  /**
   * Speech recognition engine preference.
   *   "auto"     — use WhisperKit when model is ready, fall back to SFSpeech otherwise.
   *   "whisper"  — WhisperKit only; surfaces model_not_ready error if model absent.
   *   "sfspeech" — iOS native SFSpeech; always available, no model download needed.
   *   "server"   — Upload M4A to the Hermes gateway for faster-whisper transcription.
   *                Requires network; falls back to on-device when offline if
   *                fallbackOnOffline is true, otherwise surfaces a blocked error.
   */
  engine: VoiceEngine;
  /**
   * Hard-stop duration in seconds for whisper / sfspeech engines.
   * At cap: stop() fires so captured audio is delivered (not discarded).
   * Range: 30–180. Default: 60.
   */
  localCapSeconds: number;
  /**
   * Hard-stop duration in seconds for the server engine.
   * Range: 60–600. Default: 300.
   */
  serverCapSeconds: number;
  /**
   * When true (default): engine="server" + offline → resolve to whisper or sfspeech.
   * When false: engine="server" + offline → surface a "blocked" error immediately.
   */
  fallbackOnOffline: boolean;
}

export interface VoiceSettingsActions {
  setEnabled: (v: boolean) => void;
  setLanguage: (lang: string | null) => void;
  setAddsPunctuation: (v: boolean) => void;
  setEngine: (e: VoiceEngine) => void;
  /** Set local cap; clamped to [30, 180]. */
  setLocalCapSeconds: (v: number) => void;
  /** Set server cap; clamped to [60, 600]. */
  setServerCapSeconds: (v: number) => void;
  setFallbackOnOffline: (v: boolean) => void;
  reset: () => void;
  hydrate: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Valid range for localCapSeconds. */
export const LOCAL_CAP_RANGE = { min: 30, max: 180 } as const;
/** Valid range for serverCapSeconds. */
export const SERVER_CAP_RANGE = { min: 60, max: 600 } as const;

const DEFAULTS: VoiceSettings = {
  enabled: true,
  language: null,
  addsPunctuation: true,
  engine: "auto",
  localCapSeconds: 60,
  serverCapSeconds: 300,
  fallbackOnOffline: true,
};

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

interface Serialized {
  enabled?: unknown;
  language?: unknown;
  addsPunctuation?: unknown;
  engine?: unknown;
  localCapSeconds?: unknown;
  serverCapSeconds?: unknown;
  fallbackOnOffline?: unknown;
}

function parseSettings(raw: string | null): VoiceSettings {
  if (!raw) return { ...DEFAULTS };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULTS };
    const r = parsed as Serialized;

    const enabled =
      typeof r.enabled === "boolean" ? r.enabled : DEFAULTS.enabled;
    const language =
      r.language === null
        ? null
        : typeof r.language === "string"
          ? r.language
          : DEFAULTS.language;
    const addsPunctuation =
      typeof r.addsPunctuation === "boolean"
        ? r.addsPunctuation
        : DEFAULTS.addsPunctuation;
    const engine: VoiceEngine =
      r.engine === "auto" ||
      r.engine === "whisper" ||
      r.engine === "sfspeech" ||
      r.engine === "server"
        ? r.engine
        : DEFAULTS.engine;

    const localCapSeconds =
      typeof r.localCapSeconds === "number" && isFinite(r.localCapSeconds)
        ? Math.min(LOCAL_CAP_RANGE.max, Math.max(LOCAL_CAP_RANGE.min, Math.round(r.localCapSeconds)))
        : DEFAULTS.localCapSeconds;

    const serverCapSeconds =
      typeof r.serverCapSeconds === "number" && isFinite(r.serverCapSeconds)
        ? Math.min(SERVER_CAP_RANGE.max, Math.max(SERVER_CAP_RANGE.min, Math.round(r.serverCapSeconds)))
        : DEFAULTS.serverCapSeconds;

    const fallbackOnOffline =
      typeof r.fallbackOnOffline === "boolean"
        ? r.fallbackOnOffline
        : DEFAULTS.fallbackOnOffline;

    return { enabled, language, addsPunctuation, engine, localCapSeconds, serverCapSeconds, fallbackOnOffline };
  } catch {
    return { ...DEFAULTS };
  }
}

function persistSettings(settings: VoiceSettings): void {
  void sqliteKv.setItem(KEY, JSON.stringify(settings)).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useVoiceSettings = create<VoiceSettings & VoiceSettingsActions>(
  (set, get) => ({
    ...DEFAULTS,

    async hydrate() {
      // Idempotent — we don't track a separate `hydrated` flag because
      // re-hydrating (e.g. from a settings screen pull-to-refresh) is benign.
      const raw = await sqliteKv.getItem(KEY);
      set(parseSettings(raw));
    },

    setEnabled(v) {
      set((s) => {
        const next = { ...s, enabled: v };
        persistSettings(next);
        return { enabled: v };
      });
    },

    setLanguage(lang) {
      set((s) => {
        const next = { ...s, language: lang };
        persistSettings(next);
        return { language: lang };
      });
    },

    setAddsPunctuation(v) {
      set((s) => {
        const next = { ...s, addsPunctuation: v };
        persistSettings(next);
        return { addsPunctuation: v };
      });
    },

    setEngine(e) {
      set((s) => {
        const next = { ...s, engine: e };
        persistSettings(next);
        return { engine: e };
      });
    },

    setLocalCapSeconds(v) {
      const clamped = Math.min(LOCAL_CAP_RANGE.max, Math.max(LOCAL_CAP_RANGE.min, Math.round(v)));
      set((s) => {
        const next = { ...s, localCapSeconds: clamped };
        persistSettings(next);
        return { localCapSeconds: clamped };
      });
    },

    setServerCapSeconds(v) {
      const clamped = Math.min(SERVER_CAP_RANGE.max, Math.max(SERVER_CAP_RANGE.min, Math.round(v)));
      set((s) => {
        const next = { ...s, serverCapSeconds: clamped };
        persistSettings(next);
        return { serverCapSeconds: clamped };
      });
    },

    setFallbackOnOffline(v) {
      set((s) => {
        const next = { ...s, fallbackOnOffline: v };
        persistSettings(next);
        return { fallbackOnOffline: v };
      });
    },

    reset() {
      persistSettings({ ...DEFAULTS });
      set({ ...DEFAULTS });
    },

    // Note: getState() accessor is provided by zustand automatically.
    // Consumers call: useVoiceSettings.getState().hydrate()
  }),
);

// Convenience re-export so callers can do:
//   import { useVoiceSettings } from "@/state/voice-settings";
// and use it as both a hook and a store reference.
// (The create() return value already serves dual purpose — this comment is
// just for discoverability.)
