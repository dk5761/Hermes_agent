/**
 * pending-memos store — durable queue for optimistic voice memo uploads.
 *
 * Each entry is created when the user releases the mic (before the file has
 * been uploaded). The uploader drains entries on upload success or failure.
 *
 * Persistence model (write-through):
 *   - `hydrate()` SELECTs all rows from `pending_memos` and populates the
 *     in-memory `byId` map. Called once from _layout.tsx before render.
 *   - Every mutating method updates in-memory state first, then fire-and-
 *     forgets the matching SQL write. DB failures are logged but never surface
 *     to the caller — the in-memory map is the source of truth.
 *
 * ID format: "local-<uuid>" where uuid comes from a tiny local helper —
 * Hermes engine doesn't expose `crypto` globally, so we mirror the pattern
 * already used by pending-mutations.ts and pending-sends.ts.
 * On upload success the chat-store ID is swapped to "hist-u-<dbId>" via
 * chat-store.renameMessage(). The pending-memo entry is then removed.
 *
 * Retry policy: 3 automatic retries with backoff [1 s, 5 s, 30 s]. After the
 * third failure the entry stays with status "failed" for manual user retry.
 * Resetting retries (via retry()) resets the counter back to 0.
 *
 * The audio file at `localAudioUri` is kept on disk until upload is
 * acknowledged and the ID swap succeeds. Two-step commit: swap → delete.
 */
import { create } from "zustand";
import { getDb } from "../db/sqlite";
import { TABLES } from "../db/schema";

/**
 * Local UUID-ish — Hermes engine has no `crypto` global, so we generate a
 * collision-resistant string from `Date.now()` + two random base36 segments.
 * Same shape used by pending-sends.ts / pending-mutations.ts.
 */
function uuid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}-${Math.random().toString(36).slice(2, 11)}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemoStatus = "uploading" | "failed";

export interface PendingMemo {
  /** Local UUID, prefixed "local-". Matches the chat-store optimistic row id. */
  id: string;
  sessionId: string;
  /** file:// URI in the app sandbox, under documentDirectory/voice-memo-pending/. */
  localAudioUri: string;
  durationMs: number;
  /** 80 normalized waveform values (0..1) captured live at record time. */
  peaks: number[];
  enqueuedAt: number;
  /** Number of attempted uploads (0 = not yet tried). Capped at MAX_RETRIES. */
  retries: number;
  status: MemoStatus;
  lastError?: string;
}

export interface PendingMemosState {
  byId: Record<string, PendingMemo>;
  hydrated: boolean;
  /** Populate from DB. Idempotent. */
  hydrate(): Promise<void>;
  /**
   * Add a new memo to the queue. Returns the generated localId.
   * @returns The "local-<uuid>" id string.
   */
  enqueue(input: {
    sessionId: string;
    localAudioUri: string;
    durationMs: number;
    peaks: number[];
  }): string;
  markFailed(id: string, error: string): void;
  markUploading(id: string): void;
  /** Remove an entry on successful upload. */
  remove(id: string): void;
  /**
   * Reset retry counter and re-mark as "uploading" so the uploader will
   * attempt another upload. Caller is responsible for triggering the upload.
   */
  retry(id: string): void;
  pendingForSession(sessionId: string): PendingMemo[];
  clearAll(): void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Upsert a pending_memos row. Fire-and-forget at every call site. */
async function flush(memo: PendingMemo): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO ${TABLES.pendingMemos}
       (id, session_id, local_audio_uri, duration_ms, peaks,
        enqueued_at, retries, status, last_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       retries    = excluded.retries,
       status     = excluded.status,
       last_error = excluded.last_error`,
    memo.id,
    memo.sessionId,
    memo.localAudioUri,
    memo.durationMs,
    JSON.stringify(memo.peaks),
    memo.enqueuedAt,
    memo.retries,
    memo.status,
    memo.lastError ?? null,
  );
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const usePendingMemos = create<PendingMemosState>((set, get) => ({
  byId: {},
  hydrated: false,

  async hydrate() {
    if (get().hydrated) return;
    const db = await getDb();
    type Row = {
      id: string;
      session_id: string;
      local_audio_uri: string;
      duration_ms: number;
      peaks: string;
      enqueued_at: number;
      retries: number;
      status: string;
      last_error: string | null;
    };
    const rows = await db.getAllAsync<Row>(
      `SELECT id, session_id, local_audio_uri, duration_ms, peaks,
              enqueued_at, retries, status, last_error
         FROM ${TABLES.pendingMemos}
        ORDER BY enqueued_at ASC`,
    );
    const byId: Record<string, PendingMemo> = {};
    for (const row of rows) {
      let peaks: unknown;
      try {
        peaks = JSON.parse(row.peaks);
      } catch {
        continue; // skip malformed rows
      }
      if (!Array.isArray(peaks)) continue;
      const status: MemoStatus = row.status === "failed" ? "failed" : "uploading";
      const memo: PendingMemo = {
        id: row.id,
        sessionId: row.session_id,
        localAudioUri: row.local_audio_uri,
        durationMs: row.duration_ms,
        peaks: peaks as number[],
        enqueuedAt: row.enqueued_at,
        retries: row.retries,
        status,
        ...(row.last_error != null ? { lastError: row.last_error } : {}),
      };
      byId[memo.id] = memo;
    }
    set({ byId, hydrated: true });
  },

  enqueue({ sessionId, localAudioUri, durationMs, peaks }) {
    const id = `local-${uuid()}`;
    const memo: PendingMemo = {
      id,
      sessionId,
      localAudioUri,
      durationMs,
      peaks,
      enqueuedAt: Date.now(),
      retries: 0,
      status: "uploading",
    };
    set((s) => ({ byId: { ...s.byId, [id]: memo } }));
    flush(memo).catch(console.warn);
    return id;
  },

  markFailed(id, error) {
    set((s) => {
      const memo = s.byId[id];
      if (!memo) return s;
      const updated: PendingMemo = {
        ...memo,
        retries: memo.retries + 1,
        status: "failed",
        lastError: error,
      };
      flush(updated).catch(console.warn);
      return { byId: { ...s.byId, [id]: updated } };
    });
  },

  markUploading(id) {
    set((s) => {
      const memo = s.byId[id];
      if (!memo) return s;
      const updated: PendingMemo = { ...memo, status: "uploading" };
      flush(updated).catch(console.warn);
      return { byId: { ...s.byId, [id]: updated } };
    });
  },

  remove(id) {
    set((s) => {
      if (!s.byId[id]) return s;
      const { [id]: _removed, ...rest } = s.byId;
      void _removed;
      getDb()
        .then((db) =>
          db.runAsync(`DELETE FROM ${TABLES.pendingMemos} WHERE id = ?`, id),
        )
        .catch(console.warn);
      return { byId: rest };
    });
  },

  retry(id) {
    set((s) => {
      const memo = s.byId[id];
      if (!memo) return s;
      // Drop lastError — stale error text misleads after an explicit retry.
      const { lastError: _drop, ...rest } = memo;
      void _drop;
      const updated: PendingMemo = { ...rest, retries: 0, status: "uploading" };
      flush(updated).catch(console.warn);
      return { byId: { ...s.byId, [id]: updated } };
    });
  },

  pendingForSession(sessionId) {
    return Object.values(get().byId).filter((m) => m.sessionId === sessionId);
  },

  clearAll() {
    set(() => {
      getDb()
        .then((db) => db.runAsync(`DELETE FROM ${TABLES.pendingMemos}`))
        .catch(console.warn);
      return { byId: {} };
    });
  },
}));
