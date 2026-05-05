/**
 * reasoning-collapse store — remembers which assistant-message reasoning
 * blocks the user has manually expanded so reopening the chat doesn't
 * reset them all to the default collapsed state.
 *
 * Default policy: completed reasoning starts collapsed (mirrors the
 * existing local-state behavior in ReasoningInline). When the user taps
 * to expand, the message id is added to `expanded`; when they collapse
 * again, it's removed. The map persists to AsyncStorage so app relaunch
 * preserves the choice. Map is global (not scoped per session) because
 * assistant message ids — `hist-a-<chat_history.id>` — are unique across
 * the gateway DB.
 *
 * Storage key: `reasoning.expanded.v1`
 */
import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "reasoning.expanded.v1";

export interface ReasoningCollapseState {
  expanded: Record<string, true>;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  isExpanded: (id: string) => boolean;
  setExpanded: (id: string, expanded: boolean) => void;
  clearAll: () => void;
}

function parse(raw: string | null): Record<string, true> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, true> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof k === "string" && k.length > 0 && v === true) out[k] = true;
    }
    return out;
  } catch {
    return {};
  }
}

function persist(value: Record<string, true>): void {
  void AsyncStorage.setItem(KEY, JSON.stringify(value)).catch(() => undefined);
}

export const useReasoningCollapse = create<ReasoningCollapseState>(
  (set, get) => ({
    expanded: {},
    hydrated: false,

    async hydrate() {
      if (get().hydrated) return;
      const raw = await AsyncStorage.getItem(KEY);
      set({ expanded: parse(raw), hydrated: true });
    },

    isExpanded(id) {
      return !!get().expanded[id];
    },

    setExpanded(id, expanded) {
      const map = { ...get().expanded };
      if (expanded) {
        map[id] = true;
      } else {
        delete map[id];
      }
      persist(map);
      set({ expanded: map });
    },

    clearAll() {
      persist({});
      set({ expanded: {} });
    },
  }),
);
