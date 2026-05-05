/**
 * pending-sends store — frame-level offline queue for the chat send path.
 *
 * Why a separate store (rather than extending chat-store):
 *   - chat-store is already large and stream-shaped; pending sends have a
 *     wholly different lifecycle (persisted across reloads, drained on WS
 *     reconnect, retried by the user).
 *   - Persistence is opinionated: every mutation writes to AsyncStorage so a
 *     hard kill of the app preserves unsent text. chat-store deliberately
 *     stays in-memory.
 *   - The drainer (ws/queue-drainer.ts) subscribes to a focused slice
 *     without re-rendering when unrelated chat state churns.
 *
 * Persistence shape on disk: { frames: Record<string, PendingFrame> } under
 * the key `chat.pending.v1`. Defensive parse — any malformed payload falls
 * back to an empty map silently so a bad write can't brick the chat send.
 */
import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";

import type { ClientFrame } from "../ws/events";

const KEY = "chat.pending.v1";

export type PendingStatus = "queued" | "sending" | "failed";

export interface PendingFrame {
  // Stable id minted at enqueue. Doubles as the user-bubble cross-ref:
  // chat-store's UserMessage.clientId points back here so the renderer can
  // overlay queued/sending/failed StatusDots.
  id: string;
  sessionId: string;
  frame: ClientFrame;
  enqueuedAt: number;
  status: PendingStatus;
  retries: number;
  lastError?: string;
}

export interface PendingSendsState {
  frames: Record<string, PendingFrame>;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  enqueue: (sessionId: string, frame: ClientFrame) => string;
  markSending: (id: string) => void;
  markSent: (id: string) => void;
  markFailed: (id: string, error: string) => void;
  // User-initiated retry — leaves the retries counter alone so a flaky
  // network can't burn the user's manual attempts. The drainer's automatic
  // retry path bumps retries via markFailed; this resets only status.
  retry: (id: string) => void;
  remove: (id: string) => void;
  framesForSession: (sessionId: string) => PendingFrame[];
  /**
   * Drop every persisted frame. Used by the Diagnostics "Reset all queues"
   * action — wipes both queued and failed entries indiscriminately.
   */
  clearAll: () => void;
}

// Math.random is fine for client-only frame keys; not security-sensitive.
// Avoids pulling in a uuid dependency for what amounts to a coordination id.
function uuid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}-${Math.random().toString(36).slice(2, 11)}`;
}

function isClientFrame(v: unknown): v is ClientFrame {
  if (!v || typeof v !== "object") return false;
  const t = (v as Record<string, unknown>)["type"];
  // Cheap structural sanity check — full validation lives at the gateway.
  // We just need to filter out blatantly-corrupt persisted entries.
  return typeof t === "string";
}

function parse(raw: string | null): Record<string, PendingFrame> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, PendingFrame> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const r = v as Record<string, unknown>;
      const id = typeof r["id"] === "string" ? r["id"] : null;
      const sessionId = typeof r["sessionId"] === "string" ? r["sessionId"] : null;
      const enqueuedAt = typeof r["enqueuedAt"] === "number" ? r["enqueuedAt"] : null;
      const status = r["status"];
      const retries = typeof r["retries"] === "number" ? r["retries"] : 0;
      const frame = r["frame"];
      if (!id || !sessionId || enqueuedAt === null) continue;
      if (status !== "queued" && status !== "sending" && status !== "failed") continue;
      if (!isClientFrame(frame)) continue;
      // Any frame persisted as `sending` belongs to a process that's already
      // gone. Reset to `queued` so the drainer picks it up again on reconnect.
      const restoredStatus: PendingStatus = status === "sending" ? "queued" : status;
      const lastError = typeof r["lastError"] === "string" ? r["lastError"] : undefined;
      out[k] = {
        id,
        sessionId,
        frame,
        enqueuedAt,
        status: restoredStatus,
        retries,
        ...(lastError ? { lastError } : {}),
      };
    }
    return out;
  } catch {
    return {};
  }
}

function persist(value: Record<string, PendingFrame>): void {
  void AsyncStorage.setItem(KEY, JSON.stringify(value)).catch(() => undefined);
}

export const usePendingSends = create<PendingSendsState>((set, get) => ({
  frames: {},
  hydrated: false,

  async hydrate() {
    if (get().hydrated) return;
    const raw = await AsyncStorage.getItem(KEY);
    set({ frames: parse(raw), hydrated: true });
  },

  enqueue(sessionId, frame) {
    const id = uuid();
    set((s) => {
      const next: Record<string, PendingFrame> = {
        ...s.frames,
        [id]: {
          id,
          sessionId,
          frame,
          enqueuedAt: Date.now(),
          status: "queued",
          retries: 0,
        },
      };
      persist(next);
      return { frames: next };
    });
    return id;
  },

  markSending(id) {
    set((s) => {
      const cur = s.frames[id];
      if (!cur) return s;
      const next = { ...s.frames, [id]: { ...cur, status: "sending" as const } };
      persist(next);
      return { frames: next };
    });
  },

  markSent(id) {
    set((s) => {
      if (!s.frames[id]) return s;
      const next = { ...s.frames };
      delete next[id];
      persist(next);
      return { frames: next };
    });
  },

  markFailed(id, error) {
    set((s) => {
      const cur = s.frames[id];
      if (!cur) return s;
      const next = {
        ...s.frames,
        [id]: {
          ...cur,
          status: "failed" as const,
          retries: cur.retries + 1,
          lastError: error,
        },
      };
      persist(next);
      return { frames: next };
    });
  },

  retry(id) {
    set((s) => {
      const cur = s.frames[id];
      if (!cur) return s;
      // User-triggered: clear lastError, keep retries (so the drainer's
      // backoff caps don't silently re-trip on subsequent failures).
      const { lastError: _drop, ...rest } = cur;
      void _drop;
      const next = { ...s.frames, [id]: { ...rest, status: "queued" as const } };
      persist(next);
      return { frames: next };
    });
  },

  remove(id) {
    set((s) => {
      if (!s.frames[id]) return s;
      const next = { ...s.frames };
      delete next[id];
      persist(next);
      return { frames: next };
    });
  },

  framesForSession(sessionId) {
    const all = get().frames;
    const out: PendingFrame[] = [];
    for (const f of Object.values(all)) {
      if (f.sessionId === sessionId) out.push(f);
    }
    out.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    return out;
  },

  clearAll() {
    set(() => {
      const next: Record<string, PendingFrame> = {};
      persist(next);
      return { frames: next };
    });
  },
}));
