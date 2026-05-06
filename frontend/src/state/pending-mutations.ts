/**
 * pending-mutations store — durable queue for session-level write mutations
 * (archive / rename / delete / setSessionModel).
 *
 * Why a separate store rather than TanStack's built-in mutation persistence:
 *   - We want explicit control over ordering, dedup, and the failure visual
 *     (Diagnostics screen lists failed entries with Retry / Discard).
 *   - Persistence shape is the same disciplined `parse + persist` pattern
 *     used by pending-sends.ts so the same defensive guarantees apply: any
 *     malformed persisted row falls back to being skipped silently.
 *
 * Persistence model (write-through):
 *   - `hydrate()` SELECTs all rows from `pending_mutations` and populates the
 *     in-memory `queue` array. Called once from _layout.tsx before render.
 *   - Every mutating method (enqueue / remove / bumpRetry / clearAll /
 *     resetForRetry) updates the in-memory array first, then fire-and-forgets
 *     the matching SQL statement. DB failures are logged but never surface to
 *     the caller — the in-memory queue is the source of truth for the UI.
 *   - The mutation-drainer reads `getState().queue` synchronously; it never
 *     needs to await a DB read on each poll tick.
 *
 * Lifecycle:
 *   1. Caller (chat list / chat detail) invokes a `pending*Session` wrapper.
 *      The wrapper enqueues a {@link PendingMutationEntry}, then attempts
 *      the API call immediately. On success the wrapper removes the entry
 *      and invalidates the relevant TanStack queries.
 *   2. If the immediate attempt fails, the entry stays in the queue. The
 *      mutation-drainer (see ws/mutation-drainer.ts) wakes on
 *      online: false → true transitions and drains the queue serially.
 *   3. Drainer increments `retries` on transient failures (5xx / network).
 *      After {@link MAX_RETRIES} the entry is marked `failed: true` and
 *      stays in the queue for manual recovery via Diagnostics (Phase 6).
 *
 * Cap: at {@link MAX_QUEUE_SIZE} entries we drop the OLDEST entry on the
 * next enqueue. This prevents an offline burst of mutations from growing
 * unbounded if the user keeps interacting after losing connectivity.
 */
import { create } from "zustand";
import type { QueryClient } from "@tanstack/react-query";

import { getDb } from "../db/sqlite";
import { TABLES } from "../db/schema";
import {
  archiveSession,
  deleteSession,
  renameSession,
  setSessionModel,
} from "../api/sessions";

/** Hard cap on retries before marking the entry `failed`. Mirrors the
 *  pending-sends drainer: 1s / 5s / 30s backoff schedule, then give up. */
export const MAX_RETRIES = 3;

/** Drop oldest when enqueueing past this size. Matches Phase 7 plan. */
export const MAX_QUEUE_SIZE = 100;

// Discriminated union — one branch per mutation kind. Adding a new kind:
//   1. Extend the union below
//   2. Add a case to the drainer's exhaustive switch
//   3. (Optionally) add a `pending*` convenience wrapper at the bottom
export type PendingMutation =
  | { kind: "session.archive"; payload: { sessionId: string; archived: boolean } }
  | { kind: "session.rename"; payload: { sessionId: string; title: string } }
  | { kind: "session.delete"; payload: { sessionId: string } }
  | {
      kind: "session.setModel";
      payload:
        | { sessionId: string; provider: string; model: string }
        | { sessionId: string; clear: true };
    };

export interface PendingMutationEntry {
  /** Stable id minted at enqueue. Used by callers to remove on success. */
  id: string;
  enqueuedAt: number;
  retries: number;
  lastError?: string;
  /**
   * `failed` flips to true once retries hits the cap. Failed entries stay
   * in the queue (the drainer skips them) until the user manually retries
   * or discards via the Diagnostics screen (Phase 6).
   */
  failed: boolean;
  mutation: PendingMutation;
}

export interface PendingMutationsState {
  queue: PendingMutationEntry[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  /** Enqueue a mutation. Returns the new entry id. */
  enqueue: (m: PendingMutation) => string;
  remove: (id: string) => void;
  /**
   * Increment retries, persist lastError. Auto-marks `failed: true` when
   * retries reaches {@link MAX_RETRIES}.
   */
  bumpRetry: (id: string, error: string) => void;
  /**
   * User-triggered: reset retries to 0 + clear failed flag so the drainer
   * picks the entry up again on the next online tick.
   */
  resetForRetry: (id: string) => void;
  /** Convenience selectors for the Diagnostics screen + offline banner. */
  pendingCount: () => number;
  failedCount: () => number;
  /**
   * Drop every entry (failed or pending). Used by the Diagnostics "Reset
   * all queues" action — the user has explicitly opted to forget queued
   * writes that haven't replayed yet.
   */
  clearAll: () => void;
}

// Math.random is fine for client-only ids; not security-sensitive. Mirrors
// pending-sends.ts so we don't pull in a uuid dep for what amounts to a
// coordination key.
function uuid(): string {
  return `${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 11)}-${Math.random().toString(36).slice(2, 11)}`;
}

function isPendingMutation(v: unknown): v is PendingMutation {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  const kind = r["kind"];
  const payload = r["payload"];
  if (typeof kind !== "string") return false;
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  if (typeof p["sessionId"] !== "string") return false;
  switch (kind) {
    case "session.archive":
      return typeof p["archived"] === "boolean";
    case "session.rename":
      return typeof p["title"] === "string";
    case "session.delete":
      return true;
    case "session.setModel":
      if (p["clear"] === true) return true;
      return typeof p["provider"] === "string" && typeof p["model"] === "string";
    default:
      return false;
  }
}

/**
 * Upsert a single entry to `pending_mutations`.
 * Uses INSERT … ON CONFLICT so both new inserts and retries/updates work.
 * Fire-and-forget at all call sites — never throws to the caller.
 */
async function flush(entry: PendingMutationEntry): Promise<void> {
  const db = await getDb();
  const { kind, payload } = entry.mutation;
  await db.runAsync(
    `INSERT INTO ${TABLES.pendingMutations}
       (id, enqueued_at, retries, last_error, kind, payload)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       retries    = excluded.retries,
       last_error = excluded.last_error`,
    entry.id,
    entry.enqueuedAt,
    entry.retries,
    entry.lastError ?? null,
    kind,
    JSON.stringify(payload),
  );
}

export const usePendingMutations = create<PendingMutationsState>((set, get) => ({
  queue: [],
  hydrated: false,

  async hydrate() {
    if (get().hydrated) return;
    const db = await getDb();
    type Row = {
      id: string;
      enqueued_at: number;
      retries: number;
      last_error: string | null;
      kind: string;
      payload: string;
    };
    const rows = await db.getAllAsync<Row>(
      `SELECT id, enqueued_at, retries, last_error, kind, payload
         FROM ${TABLES.pendingMutations}
        ORDER BY enqueued_at ASC`,
    );
    const queue: PendingMutationEntry[] = [];
    for (const row of rows) {
      let parsedPayload: unknown;
      try {
        parsedPayload = JSON.parse(row.payload);
      } catch {
        continue; // skip malformed rows
      }
      const mutation: unknown = { kind: row.kind, payload: parsedPayload };
      if (!isPendingMutation(mutation)) continue;
      const entry: PendingMutationEntry = {
        id: row.id,
        enqueuedAt: row.enqueued_at,
        retries: row.retries,
        failed: row.retries >= MAX_RETRIES,
        mutation,
        ...(row.last_error != null ? { lastError: row.last_error } : {}),
      };
      queue.push(entry);
    }
    set({ queue, hydrated: true });
  },

  enqueue(mutation) {
    const id = uuid();
    const entry: PendingMutationEntry = {
      id,
      enqueuedAt: Date.now(),
      retries: 0,
      failed: false,
      mutation,
    };
    set((s) => {
      let next: PendingMutationEntry[];
      if (s.queue.length >= MAX_QUEUE_SIZE) {
        // Drop the oldest entry to keep the queue bounded. Warn once per
        // drop so noisy churn shows up in DEV builds — silent in prod.
        if (__DEV__) {
          // eslint-disable-next-line no-console
          console.warn(
            "[pending-mutations] queue at cap (%d), dropping oldest entry",
            MAX_QUEUE_SIZE,
          );
        }
        const dropped = s.queue[0];
        if (dropped) {
          getDb()
            .then((db) =>
              db.runAsync(
                `DELETE FROM ${TABLES.pendingMutations} WHERE id = ?`,
                dropped.id,
              ),
            )
            .catch(console.warn);
        }
        next = [...s.queue.slice(1), entry];
      } else {
        next = [...s.queue, entry];
      }
      flush(entry).catch(console.warn);
      return { queue: next };
    });
    return id;
  },

  remove(id) {
    set((s) => {
      const idx = s.queue.findIndex((e) => e.id === id);
      if (idx === -1) return s;
      const next = [...s.queue.slice(0, idx), ...s.queue.slice(idx + 1)];
      getDb()
        .then((db) =>
          db.runAsync(
            `DELETE FROM ${TABLES.pendingMutations} WHERE id = ?`,
            id,
          ),
        )
        .catch(console.warn);
      return { queue: next };
    });
  },

  bumpRetry(id, error) {
    set((s) => {
      const idx = s.queue.findIndex((e) => e.id === id);
      if (idx === -1) return s;
      const cur = s.queue[idx];
      if (!cur) return s;
      const retries = cur.retries + 1;
      const failed = retries >= MAX_RETRIES;
      const updated: PendingMutationEntry = {
        ...cur,
        retries,
        failed,
        lastError: error,
      };
      const next = [...s.queue];
      next[idx] = updated;
      flush(updated).catch(console.warn);
      return { queue: next };
    });
  },

  resetForRetry(id) {
    set((s) => {
      const idx = s.queue.findIndex((e) => e.id === id);
      if (idx === -1) return s;
      const cur = s.queue[idx];
      if (!cur) return s;
      // Drop lastError too — a stale "Network request failed" is misleading
      // after the user has explicitly asked the drainer to try again.
      const { lastError: _drop, ...rest } = cur;
      void _drop;
      const updated: PendingMutationEntry = { ...rest, retries: 0, failed: false };
      const next = [...s.queue];
      next[idx] = updated;
      flush(updated).catch(console.warn);
      return { queue: next };
    });
  },

  pendingCount() {
    let n = 0;
    for (const e of get().queue) if (!e.failed) n += 1;
    return n;
  },

  failedCount() {
    let n = 0;
    for (const e of get().queue) if (e.failed) n += 1;
    return n;
  },

  clearAll() {
    set(() => {
      getDb()
        .then((db) =>
          db.runAsync(`DELETE FROM ${TABLES.pendingMutations}`),
        )
        .catch(console.warn);
      return { queue: [] };
    });
  },
}));

// ─── convenience wrappers ────────────────────────────────────────────────────
//
// Each wrapper enqueues + tries the API call immediately. On success it
// removes the queue entry and invalidates the sessions query. On failure it
// stays silent — the mutation-drainer will retry on the next online tick.
// These are fire-and-forget at the call site (don't throw).

const SESSIONS_KEY = ["sessions"] as const;

async function tryImmediate(
  pendingId: string,
  call: () => Promise<unknown>,
  queryClient: QueryClient,
): Promise<void> {
  try {
    await call();
    usePendingMutations.getState().remove(pendingId);
    void queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
  } catch {
    // Drainer will retry; the failed-banner / Diagnostics surface (Phase 6)
    // tells the user when retries exhaust. No toast here on purpose —
    // queueing IS the success path for offline writes.
  }
}

export async function pendingArchiveSession(
  id: string,
  archived: boolean,
  queryClient: QueryClient,
): Promise<void> {
  const pendingId = usePendingMutations.getState().enqueue({
    kind: "session.archive",
    payload: { sessionId: id, archived },
  });
  await tryImmediate(pendingId, () => archiveSession(id, archived), queryClient);
}

export async function pendingRenameSession(
  id: string,
  title: string,
  queryClient: QueryClient,
): Promise<void> {
  const pendingId = usePendingMutations.getState().enqueue({
    kind: "session.rename",
    payload: { sessionId: id, title },
  });
  await tryImmediate(pendingId, () => renameSession(id, title), queryClient);
}

export async function pendingDeleteSession(
  id: string,
  queryClient: QueryClient,
): Promise<void> {
  const pendingId = usePendingMutations.getState().enqueue({
    kind: "session.delete",
    payload: { sessionId: id },
  });
  await tryImmediate(pendingId, () => deleteSession(id), queryClient);
}

export async function pendingSetSessionModel(
  id: string,
  body: { provider: string; model: string } | { clear: true },
  queryClient: QueryClient,
): Promise<void> {
  const payload: PendingMutation["payload"] =
    "clear" in body
      ? { sessionId: id, clear: true }
      : { sessionId: id, provider: body.provider, model: body.model };
  const pendingId = usePendingMutations.getState().enqueue({
    kind: "session.setModel",
    payload,
  });
  await tryImmediate(pendingId, () => setSessionModel(id, body), queryClient);
}
