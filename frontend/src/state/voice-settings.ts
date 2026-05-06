/**
 * Voice settings store — Zustand + SQLite persistence.
 *
 * Persists five preferences:
 *   enabled         — whether voice input is surfaced at all
 *   mode            — "ptt" (press-and-hold) or "toggle" (tap on/off)
 *   language        — null means "use device locale"; otherwise a BCP-47 tag
 *   addsPunctuation — Apple's auto-punctuation (SFSpeechRecognitionRequest).
 *                     Only meaningful when the SFSpeech engine is active.
 *   engine          — "auto" | "whisper" | "sfspeech". Default "auto".
 *                     "auto" resolves at start() time based on WhisperKit model
 *                     readiness (see resolveEngine in useVoiceInput).
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
export type VoiceEngine = "auto" | "whisper" | "sfspeech";

export interface VoiceSettings {
  enabled: boolean;
  mode: "ptt" | "toggle";
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
   */
  engine: VoiceEngine;
}

export interface VoiceSettingsActions {
  setEnabled: (v: boolean) => void;
  setMode: (m: "ptt" | "toggle") => void;
  setLanguage: (lang: string | null) => void;
  setAddsPunctuation: (v: boolean) => void;
  setEngine: (e: VoiceEngine) => void;
  reset: () => void;
  hydrate: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Defaults (D1: PTT; D4: device locale = null)
// ---------------------------------------------------------------------------

const DEFAULTS: VoiceSettings = {
  enabled: true,
  mode: "ptt",
  language: null,
  addsPunctuation: true,
  engine: "auto",
};

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

interface Serialized {
  enabled?: unknown;
  mode?: unknown;
  language?: unknown;
  addsPunctuation?: unknown;
  engine?: unknown;
}

function parseSettings(raw: string | null): VoiceSettings {
  if (!raw) return { ...DEFAULTS };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULTS };
    const r = parsed as Serialized;

    const enabled =
      typeof r.enabled === "boolean" ? r.enabled : DEFAULTS.enabled;
    const mode =
      r.mode === "ptt" || r.mode === "toggle" ? r.mode : DEFAULTS.mode;
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
      r.engine === "auto" || r.engine === "whisper" || r.engine === "sfspeech"
        ? r.engine
        : DEFAULTS.engine;

    return { enabled, mode, language, addsPunctuation, engine };
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

    setMode(m) {
      set((s) => {
        const next = { ...s, mode: m };
        persistSettings(next);
        return { mode: m };
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
