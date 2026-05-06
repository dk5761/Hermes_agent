/**
 * Storage diagnostics — stats, vacuum, and destructive wipe helpers.
 *
 * All functions are async and should be called from UI actions only (not hot
 * paths). None of these are reactive; callers must re-invoke after mutations
 * to see updated values.
 *
 * Uses the new expo-file-system v55 `File` / `Paths` API instead of the
 * deprecated `getInfoAsync` / `documentDirectory` helpers.
 */
import { File, Paths } from "expo-file-system";

import { getDb, closeDb, withTx } from "./sqlite";

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns a `File` reference for a path relative to the SQLite directory
 * inside the app's document directory.
 *
 * expo-sqlite stores databases at `<documentDirectory>/SQLite/<name>`.
 */
function sqliteFile(name: string): File {
  return new File(Paths.document, "SQLite", name);
}

// ─── stats ───────────────────────────────────────────────────────────────────

export interface DbStats {
  /** Raw byte count of the DB file (-1 if the file does not exist). */
  fileBytes: number;
  /** Row count in `rq_cache`. */
  rqCache: number;
  /** Row count in `kv`. */
  kv: number;
  /** Row count in `pending_mutations`. */
  pendingMutations: number;
  /** Row count in `pending_sends`. */
  pendingSends: number;
  /** Row count in `meta`. */
  meta: number;
}

/**
 * Returns file-system size and per-table row counts for the SQLite DB.
 *
 * @returns Stats snapshot. `fileBytes` is -1 when the file does not exist.
 */
export async function getDbStats(): Promise<DbStats> {
  const dbFile = sqliteFile("hermes.db");

  // File.size is a synchronous property — 0 when the file does not exist.
  // We use -1 sentinel to distinguish "missing" from a genuine 0-byte file.
  const fileBytes = dbFile.exists ? dbFile.size : -1;

  const db = await getDb();

  type CountRow = { n: number };
  const [rqRow, kvRow, mutRow, sendsRow, metaRow] = await Promise.all([
    db.getFirstAsync<CountRow>("SELECT COUNT(*) AS n FROM rq_cache"),
    db.getFirstAsync<CountRow>("SELECT COUNT(*) AS n FROM kv"),
    db.getFirstAsync<CountRow>("SELECT COUNT(*) AS n FROM pending_mutations"),
    db.getFirstAsync<CountRow>("SELECT COUNT(*) AS n FROM pending_sends"),
    db.getFirstAsync<CountRow>("SELECT COUNT(*) AS n FROM meta"),
  ]);

  return {
    fileBytes,
    rqCache: rqRow?.n ?? 0,
    kv: kvRow?.n ?? 0,
    pendingMutations: mutRow?.n ?? 0,
    pendingSends: sendsRow?.n ?? 0,
    meta: metaRow?.n ?? 0,
  };
}

// ─── maintenance ─────────────────────────────────────────────────────────────

/**
 * Runs SQLite VACUUM to reclaim free pages after bulk deletes.
 *
 * VACUUM cannot run inside a transaction — do not wrap it.
 */
export async function vacuumDb(): Promise<void> {
  const db = await getDb();
  await db.execAsync("VACUUM");
}

/**
 * Deletes all rows from `rq_cache` and the matching `rq_meta` key in `meta`.
 *
 * This matches the structure written by the Phase 2 SQLite persister which
 * stores the serialised cache client state under a `meta` key named by the
 * persister's buster/version string.
 */
export async function clearRqCache(): Promise<void> {
  const db = await getDb();
  await withTx(db, async () => {
    await db.execAsync("DELETE FROM rq_cache");
    await db.runAsync("DELETE FROM meta WHERE key = ?", "rq_meta");
  });
}

/**
 * Deletes all rows from `pending_mutations` and `pending_sends` in one
 * transaction. Does NOT touch in-memory Zustand state — callers must also
 * clear the in-memory snapshots.
 */
export async function clearAllQueues(): Promise<void> {
  const db = await getDb();
  await withTx(db, async () => {
    await db.execAsync("DELETE FROM pending_mutations");
    await db.execAsync("DELETE FROM pending_sends");
  });
}

// ─── nuclear option ───────────────────────────────────────────────────────────

/**
 * Closes the DB, deletes the SQLite file (+ WAL/SHM companions), then
 * re-opens it so migrations run against the empty file.
 *
 * Auth values stored in SecureStore are unaffected.
 * In-memory Zustand state is now stale — the caller should prompt the user
 * to restart the app.
 */
export async function wipeEverything(): Promise<void> {
  await closeDb();

  // Delete main file + WAL/SHM companions. Best-effort: missing files are not
  // an error (the WAL may not exist on a freshly opened DB).
  const companions = [
    sqliteFile("hermes.db"),
    sqliteFile("hermes.db-shm"),
    sqliteFile("hermes.db-wal"),
  ];

  for (const file of companions) {
    try {
      if (file.exists) file.delete();
    } catch {
      // Best-effort — don't crash if a companion file is missing or locked.
    }
  }

  // Re-open: runs migrations against the now-empty file.
  await getDb();
}
