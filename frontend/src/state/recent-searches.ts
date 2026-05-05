/**
 * recent-searches store — MRU list of the last N search queries the user has
 * committed (i.e. tapped a result for). Persisted to AsyncStorage.
 *
 * Mirrors the `pinned-sessions` store: synchronous in-memory state, write-
 * through persistence on every mutation, async hydration on first mount.
 *
 * De-dup is case-insensitive: pushing "Auth Refactor" when "auth refactor"
 * is already at index 3 simply moves the existing entry to index 0 (and
 * preserves the original casing of the new push).
 */
import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "search.recent.v1";
const MAX_ITEMS = 10;

export interface RecentSearchesState {
  recent: string[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  push: (q: string) => void;
  clear: () => void;
}

function parse(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const v of parsed) {
      if (typeof v === "string" && v.trim().length > 0) out.push(v);
      if (out.length >= MAX_ITEMS) break;
    }
    return out;
  } catch {
    return [];
  }
}

function persist(value: string[]): void {
  void AsyncStorage.setItem(KEY, JSON.stringify(value)).catch(() => undefined);
}

export const useRecentSearches = create<RecentSearchesState>((set, get) => ({
  recent: [],
  hydrated: false,

  async hydrate() {
    if (get().hydrated) return;
    const raw = await AsyncStorage.getItem(KEY);
    set({ recent: parse(raw), hydrated: true });
  },

  push(q) {
    const trimmed = q.trim();
    if (trimmed.length === 0) return;
    set((s) => {
      const lc = trimmed.toLowerCase();
      // Drop any prior occurrence (case-insensitive), then prepend the new one.
      const filtered = s.recent.filter((it) => it.toLowerCase() !== lc);
      const next = [trimmed, ...filtered].slice(0, MAX_ITEMS);
      persist(next);
      return { recent: next };
    });
  },

  clear() {
    persist([]);
    set({ recent: [] });
  },
}));
