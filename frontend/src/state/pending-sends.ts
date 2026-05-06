/**
 * pending-sends store — frame-level offline queue for the chat send path.
 *
 * Why a separate store (rather than extending chat-store):
 *   - chat-store is already large and stream-shaped; pending sends have a
 *     wholly different lifecycle (persisted across reloads, drained on WS
 *     reconnect, retried by the user).
 *   - Persistence is write-through to SQLite (`pending_sends` table) so a
 *     hard kill of the app preserves unsent text. chat-store deliberately
 *     stays in-memory.
 *   - The drainer (ws/queue-drainer.ts) subscribes to a focused slice
 *     without re-rendering when unrelated chat state churns.
 *
 * Persistence model (write-through):
 *   - `hydrate()` SELECTs all rows from `pending_sends` and populates the
 *     in-memory `frames` map. Called once from _layout.tsx before render.
 *   - Every mutating method updates in-memory state first, then
 *     fire-and-forgets the matching SQL write. DB failures are logged
 *     (console.warn) but never surface to the caller — the in-memory map is
 *     the source of truth for the UI.
 *   - The full ClientFrame is serialised as JSON into the `text` column so
 *     all frame variants round-trip correctly. The `attachments` column is
 *     reserved for future use (always NULL in this version).
 *
 * Per-session cap of 50 frames is enforced both in-memory (evict oldest on
 * enqueue) and in SQL (DELETE … NOT IN … LIMIT 50) so the live UI and the DB
 * stay in sync.
 */
import { create } from "zustand";

import type { ClientFrame } from "../ws/events";
import { getDb } from "../db/sqlite";
import { TABLES } from "../db/schema";

/** Per-session cap on retained frames. */
const MAX_FRAMES_PER_SESSION = 50;

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
function uuid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}-${Math.random().toString(36).slice(2, 11)}`;
}

function isClientFrame(v: unknown): v is ClientFrame {
  if (!v || typeof v !== "object") return false;
  const t = (v as Record<string, unknown>)["type"];
  // Cheap structural sanity check — full validation lives at the gateway.
  return typeof t === "string";
}

/**
 * Upsert a single PendingFrame to `pending_sends`.
 * The full ClientFrame is serialised as JSON into the `text` column.
 * `attachments` column is reserved; always NULL in this version.
 * Fire-and-forget at all call sites — never throws to the caller.
 */
async function flush(entry: PendingFrame): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO ${TABLES.pendingSends}
       (id, session_id, enqueued_at, text, attachments, status, retries)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status      = excluded.status,
       retries     = excluded.retries,
       attachments = excluded.attachments,
       text        = excluded.text`,
    entry.id,
    entry.sessionId,
    entry.enqueuedAt,
    JSON.stringify(entry.frame),
    null,
    entry.status,
    entry.retries,
  );
}

/**
 * Delete excess rows for a session, keeping the 50 most-recent by
 * enqueued_at. Run after enqueue so the DB stays in sync with the in-memory
 * eviction performed in the same operation.
 */
async function trimSessionInDb(sessionId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `DELETE FROM ${TABLES.pendingSends}
     WHERE session_id = ? AND id NOT IN (
       SELECT id FROM ${TABLES.pendingSends}
       WHERE session_id = ?
       ORDER BY enqueued_at DESC
       LIMIT ${MAX_FRAMES_PER_SESSION}
     )`,
    sessionId,
    sessionId,
  );
}

export const usePendingSends = create<PendingSendsState>((set, get) => ({
  frames: {},
  hydrated: false,

  async hydrate() {
    if (get().hydrated) return;
    const db = await getDb();
    type Row = {
      id: string;
      session_id: string;
      enqueued_at: number;
      text: string;
      status: string;
      retries: number;
    };
    const rows = await db.getAllAsync<Row>(
      `SELECT id, session_id, enqueued_at, text, status, retries
         FROM ${TABLES.pendingSends}
        ORDER BY enqueued_at ASC`,
    );
    const frames: Record<string, PendingFrame> = {};
    for (const row of rows) {
      let parsedFrame: unknown;
      try {
        parsedFrame = JSON.parse(row.text);
      } catch {
        continue; // skip malformed rows
      }
      if (!isClientFrame(parsedFrame)) continue;
      const status = row.status;
      if (status !== "queued" && status !== "sending" && status !== "failed") continue;
      // Any frame persisted as `sending` belongs to a process that's already
      // gone. Reset to `queued` so the drainer picks it up again on reconnect.
      const restoredStatus: PendingStatus = status === "sending" ? "queued" : status;
      frames[row.id] = {
        id: row.id,
        sessionId: row.session_id,
        frame: parsedFrame,
        enqueuedAt: row.enqueued_at,
        status: restoredStatus,
        retries: row.retries,
      };
    }
    set({ frames, hydrated: true });
  },

  enqueue(sessionId, frame) {
    const id = uuid();
    set((s) => {
      const entry: PendingFrame = {
        id,
        sessionId,
        frame,
        enqueuedAt: Date.now(),
        status: "queued",
        retries: 0,
      };
      const next: Record<string, PendingFrame> = { ...s.frames, [id]: entry };

      // Evict oldest frame(s) for this session if we're at the per-session cap.
      const sessionFrames = Object.values(next).filter(
        (f) => f.sessionId === sessionId,
      );
      if (sessionFrames.length > MAX_FRAMES_PER_SESSION) {
        sessionFrames.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
        const overflow = sessionFrames.length - MAX_FRAMES_PER_SESSION;
        for (let i = 0; i < overflow; i++) {
          const evict = sessionFrames[i];
          if (evict) delete next[evict.id];
        }
        if (__DEV__) {
          // eslint-disable-next-line no-console
          console.warn(
            "[pending-sends] session %s at cap (%d), evicted %d oldest",
            sessionId,
            MAX_FRAMES_PER_SESSION,
            overflow,
          );
        }
      }

      // Write new entry to DB, then trim excess rows for this session.
      flush(entry).catch(console.warn);
      trimSessionInDb(sessionId).catch(console.warn);

      return { frames: next };
    });
    return id;
  },

  markSending(id) {
    set((s) => {
      const cur = s.frames[id];
      if (!cur) return s;
      const updated: PendingFrame = { ...cur, status: "sending" };
      flush(updated).catch(console.warn);
      return { frames: { ...s.frames, [id]: updated } };
    });
  },

  markSent(id) {
    set((s) => {
      if (!s.frames[id]) return s;
      const next = { ...s.frames };
      delete next[id];
      getDb()
        .then((db) =>
          db.runAsync(
            `DELETE FROM ${TABLES.pendingSends} WHERE id = ?`,
            id,
          ),
        )
        .catch(console.warn);
      return { frames: next };
    });
  },

  markFailed(id, error) {
    set((s) => {
      const cur = s.frames[id];
      if (!cur) return s;
      const updated: PendingFrame = {
        ...cur,
        status: "failed",
        retries: cur.retries + 1,
        lastError: error,
      };
      flush(updated).catch(console.warn);
      return { frames: { ...s.frames, [id]: updated } };
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
      const updated: PendingFrame = { ...rest, status: "queued" };
      flush(updated).catch(console.warn);
      return { frames: { ...s.frames, [id]: updated } };
    });
  },

  remove(id) {
    set((s) => {
      if (!s.frames[id]) return s;
      const next = { ...s.frames };
      delete next[id];
      getDb()
        .then((db) =>
          db.runAsync(
            `DELETE FROM ${TABLES.pendingSends} WHERE id = ?`,
            id,
          ),
        )
        .catch(console.warn);
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
      getDb()
        .then((db) => db.runAsync(`DELETE FROM ${TABLES.pendingSends}`))
        .catch(console.warn);
      return { frames: {} };
    });
  },
}));
