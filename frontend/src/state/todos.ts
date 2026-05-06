/**
 * todos UI store — per-card pin/collapse state, persisted to AsyncStorage.
 *
 * Key shape: `${sessionId}:${toolCallId}` so togglePinned can scope "only one
 * pinned per session" by stripping the prefix.
 */
import { create } from "zustand";
import { sqliteKv } from "@/state/sqlite-kv";

const KEY_PINNED = "todos.pinned.v1";
const KEY_COLLAPSED = "todos.collapsed.v1";

export type TodosCardKey = string;

export interface TodosUiState {
  pinnedByCard: Record<TodosCardKey, boolean>;
  collapsedByCard: Record<TodosCardKey, boolean>;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  // sessionId is derived from `key` but we accept it explicitly so we can
  // unpin any sibling card in the same session in one mutation.
  togglePinned: (key: TodosCardKey, sessionId: string) => void;
  toggleCollapsed: (key: TodosCardKey) => void;
}

function parseRecord(raw: string | null): Record<string, boolean> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "boolean") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function persist(key: string, value: Record<string, boolean>): void {
  // Best-effort write; failures don't surface to the UI (state is non-critical).
  void sqliteKv.setItem(key, JSON.stringify(value)).catch(() => undefined);
}

export const useTodosUi = create<TodosUiState>((set, get) => ({
  pinnedByCard: {},
  collapsedByCard: {},
  hydrated: false,

  async hydrate() {
    if (get().hydrated) return;
    const [pinnedRaw, collapsedRaw] = await Promise.all([
      sqliteKv.getItem(KEY_PINNED),
      sqliteKv.getItem(KEY_COLLAPSED),
    ]);
    set({
      pinnedByCard: parseRecord(pinnedRaw),
      collapsedByCard: parseRecord(collapsedRaw),
      hydrated: true,
    });
  },

  togglePinned(key, sessionId) {
    set((s) => {
      const wasPinned = !!s.pinnedByCard[key];
      const next: Record<string, boolean> = {};
      const prefix = `${sessionId}:`;
      // Keep all foreign-session pins untouched; clear same-session siblings.
      for (const [k, v] of Object.entries(s.pinnedByCard)) {
        if (k.startsWith(prefix)) continue;
        if (v) next[k] = true;
      }
      if (!wasPinned) next[key] = true;
      persist(KEY_PINNED, next);
      return { pinnedByCard: next };
    });
  },

  toggleCollapsed(key) {
    set((s) => {
      const next = { ...s.collapsedByCard };
      if (next[key]) delete next[key];
      else next[key] = true;
      persist(KEY_COLLAPSED, next);
      return { collapsedByCard: next };
    });
  },
}));
