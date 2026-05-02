/**
 * session-tags store — per-session tag list, persisted to AsyncStorage.
 *
 * Tags are free-form short strings the user attaches to a chat to organize
 * the list (e.g., "work", "research", "todo"). Stored entirely client-side;
 * no backend involvement. Each session can have any number of tags.
 *
 * Usage:
 *   - useSessionTags((s) => s.tagsBySession[id]) — read tags for a session
 *   - useSessionTags((s) => s.allTags()) — distinct sorted union for the
 *     filter chips row
 *   - useSessionTags.getState().setTags(id, tags) — replace
 *
 * Tags are normalized to lowercase + trimmed so "Work" and "work " merge.
 */
import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "sessions.tags.v1";

export interface SessionTagsState {
  tagsBySession: Record<string, string[]>;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  getTags: (sessionId: string) => string[];
  setTags: (sessionId: string, tags: string[]) => void;
  addTag: (sessionId: string, tag: string) => void;
  removeTag: (sessionId: string, tag: string) => void;
  allTags: () => string[];
}

function normalize(t: string): string {
  return t.trim().toLowerCase().replace(/\s+/g, " ");
}

function parse(raw: string | null): Record<string, string[]> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(v)) continue;
      const tags: string[] = [];
      for (const t of v) {
        if (typeof t !== "string") continue;
        const n = normalize(t);
        if (n && !tags.includes(n)) tags.push(n);
      }
      if (tags.length > 0) out[k] = tags;
    }
    return out;
  } catch {
    return {};
  }
}

function persist(value: Record<string, string[]>): void {
  void AsyncStorage.setItem(KEY, JSON.stringify(value)).catch(() => undefined);
}

export const useSessionTags = create<SessionTagsState>((set, get) => ({
  tagsBySession: {},
  hydrated: false,

  async hydrate() {
    if (get().hydrated) return;
    const raw = await AsyncStorage.getItem(KEY);
    set({ tagsBySession: parse(raw), hydrated: true });
  },

  getTags(sessionId) {
    return get().tagsBySession[sessionId] ?? [];
  },

  setTags(sessionId, tags) {
    set((s) => {
      const cleaned: string[] = [];
      for (const t of tags) {
        const n = normalize(t);
        if (n && !cleaned.includes(n)) cleaned.push(n);
      }
      const next = { ...s.tagsBySession };
      if (cleaned.length === 0) delete next[sessionId];
      else next[sessionId] = cleaned;
      persist(next);
      return { tagsBySession: next };
    });
  },

  addTag(sessionId, tag) {
    const n = normalize(tag);
    if (!n) return;
    set((s) => {
      const cur = s.tagsBySession[sessionId] ?? [];
      if (cur.includes(n)) return s;
      const next = { ...s.tagsBySession, [sessionId]: [...cur, n] };
      persist(next);
      return { tagsBySession: next };
    });
  },

  removeTag(sessionId, tag) {
    const n = normalize(tag);
    set((s) => {
      const cur = s.tagsBySession[sessionId] ?? [];
      if (!cur.includes(n)) return s;
      const filtered = cur.filter((t) => t !== n);
      const next = { ...s.tagsBySession };
      if (filtered.length === 0) delete next[sessionId];
      else next[sessionId] = filtered;
      persist(next);
      return { tagsBySession: next };
    });
  },

  allTags() {
    const seen = new Set<string>();
    for (const list of Object.values(get().tagsBySession)) {
      for (const t of list) seen.add(t);
    }
    return Array.from(seen).sort();
  },
}));
