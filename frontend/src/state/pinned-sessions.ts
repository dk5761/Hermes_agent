/**
 * pinned-sessions store — set of sessionIds the user has pinned to the top
 * of the chat list. Persisted to AsyncStorage.
 */
import { create } from "zustand";
import { sqliteKv } from "@/state/sqlite-kv";

const KEY = "sessions.pinned.v1";

export interface PinnedSessionsState {
  pinned: Record<string, boolean>;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  isPinned: (id: string) => boolean;
  togglePinned: (id: string) => void;
}

function parse(raw: string | null): Record<string, boolean> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "boolean" && v) out[k] = true;
    }
    return out;
  } catch {
    return {};
  }
}

function persist(value: Record<string, boolean>): void {
  void sqliteKv.setItem(KEY, JSON.stringify(value)).catch(() => undefined);
}

export const usePinnedSessions = create<PinnedSessionsState>((set, get) => ({
  pinned: {},
  hydrated: false,

  async hydrate() {
    if (get().hydrated) return;
    const raw = await sqliteKv.getItem(KEY);
    set({ pinned: parse(raw), hydrated: true });
  },

  isPinned(id) {
    return !!get().pinned[id];
  },

  togglePinned(id) {
    set((s) => {
      const next = { ...s.pinned };
      if (next[id]) delete next[id];
      else next[id] = true;
      persist(next);
      return { pinned: next };
    });
  },
}));
