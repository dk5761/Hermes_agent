import { openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";
import { runMigrations } from "./migrations";
import { PERSIST_MAX_AGE } from "../cache/persist-constants";

/**
 * expo-sqlite issues BEGIN/COMMIT against the single shared connection — two
 * concurrent `withTransactionAsync` calls collide ("cannot start a transaction
 * within a transaction"). Every transaction in the app must serialise through
 * this queue so we never overlap.
 *
 * @param db   - Open database handle.
 * @param fn   - Body to run inside a transaction. Awaited.
 */
let txQueue: Promise<unknown> = Promise.resolve();
export function withTx<T>(
  db: SQLiteDatabase,
  fn: () => Promise<T>,
): Promise<T> {
  const next = txQueue.then<T>(async () => {
    let result: T;
    await db.withTransactionAsync(async () => {
      result = await fn();
    });
    return result!;
  });
  // Don't let one rejected tx poison the chain — swallow at the queue level
  // while still surfacing the error to the caller.
  txQueue = next.catch(() => undefined);
  return next;
}

/**
 * Prune stale rows from the three durable tables on every boot.
 *
 * Runs inside a single transaction so the three deletes are atomic.
 * Errors surface instead of being swallowed — a broken DB should fail loudly
 * at boot rather than silently at the first real query.
 *
 * @param db - Open database handle (pre-migrations).
 */
async function runBootHygiene(db: SQLiteDatabase): Promise<void> {
  const cutoff = Date.now() - PERSIST_MAX_AGE;
  let rq = 0;
  let mut = 0;
  let sends = 0;

  await withTx(db, async () => {
    const rqResult = await db.runAsync(
      "DELETE FROM rq_cache WHERE updated_at < ?",
      cutoff,
    );
    rq = rqResult.changes;

    const mutResult = await db.runAsync(
      "DELETE FROM pending_mutations WHERE retries >= 5",
    );
    mut = mutResult.changes;

    const sendsResult = await db.runAsync(
      "DELETE FROM pending_sends WHERE retries >= 5",
    );
    sends = sendsResult.changes;
  });

  console.log(`[db] hygiene: rq=${rq} mut=${mut} sends=${sends}`);
}

/** Cached handle — set once after migrations complete. */
let cached: SQLiteDatabase | null = null;

/**
 * In-flight promise guard: if two callers race on first open we return the
 * same Promise rather than opening the DB twice.
 */
let opening: Promise<SQLiteDatabase> | null = null;

/**
 * Returns the shared SQLiteDatabase handle. On first call:
 *   1. Opens "hermes.db" via expo-sqlite (WAL mode, NORMAL sync).
 *   2. Runs all pending migrations.
 *   3. Caches the handle for subsequent sync-fast returns.
 *
 * Concurrent first calls receive the same in-flight Promise.
 *
 * @returns Resolved database handle, ready for queries.
 */
export async function getDb(): Promise<SQLiteDatabase> {
  if (cached !== null) return cached;

  if (opening !== null) return opening;

  opening = (async () => {
    const db = await openDatabaseAsync("hermes.db");

    // WAL mode keeps readers from blocking writers; NORMAL sync is safe for
    // a local cache (no durability requirement beyond the WAL checkpoint).
    await db.execAsync(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;",
    );

    await runMigrations(db);

    // Boot hygiene: prune stale rows so the DB stays bounded every launch.
    await runBootHygiene(db);

    const versionRow = await db.getFirstAsync<{ version: number }>(
      "SELECT version FROM schema_version LIMIT 1",
    );
    const schemaVersion = versionRow?.version ?? 0;
    console.log(`[db] ready, schema_version=${schemaVersion}`);

    cached = db;
    opening = null;
    return db;
  })();

  return opening;
}

/**
 * Closes the database and clears the cached handle.
 * Intended for tests and the "wipe everything" diagnostics action.
 * Normal app code should never call this.
 */
export async function closeDb(): Promise<void> {
  if (cached !== null) {
    await cached.closeAsync();
    cached = null;
  }
  opening = null;
}
