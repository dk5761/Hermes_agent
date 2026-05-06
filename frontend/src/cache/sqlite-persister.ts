import type { PersistedClient, Persister } from "@tanstack/react-query-persist-client";
import { getDb, withTx } from "@/db/sqlite";
import { TABLES } from "@/db/schema";

interface SQLitePersisterOptions {
  buster: string;
  maxAge: number;
}

/**
 * Creates a TanStack Query persister backed by the shared SQLite database.
 *
 * Each query is stored as a separate row in `rq_cache`, keyed by the
 * JSON-stringified queryKey. This avoids the single-blob bottleneck of the
 * AsyncStorage persister and lets SQL prune expired rows without loading the
 * full cache into memory.
 *
 * Mutations are NOT persisted — the app maintains its own `pending_mutations`
 * queue. `restoreClient` always returns `mutations: []`.
 *
 * @param opts.buster   Cache-busting string. Stored alongside the cache so
 *                      PersistQueryClientProvider can detect stale persists.
 * @param opts.maxAge   Max row age in ms. Rows older than this are pruned on
 *                      each `persistClient` call and excluded from `restoreClient`.
 */
export function createSQLitePersister(opts: SQLitePersisterOptions): Persister {
  return {
    async persistClient(client: PersistedClient): Promise<void> {
      const db = await getDb();
      const now = Date.now();
      const queries = client.clientState.queries;

      await withTx(db, async () => {
        // Upsert every query in the current dehydrated snapshot. The queries
        // array has already been filtered by PersistQueryClientProvider's
        // dehydrateOptions.shouldDehydrateQuery before reaching us here.
        for (const q of queries) {
          const key = JSON.stringify(q.queryKey);
          const state = JSON.stringify(q);
          await db.runAsync(
            `INSERT INTO ${TABLES.rqCache} (query_key, state, updated_at) VALUES (?, ?, ?) ` +
              `ON CONFLICT(query_key) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at`,
            key,
            state,
            now,
          );
        }

        // Prune rows that have passed their TTL in the same transaction so
        // the cache never grows stale entries between pruning passes.
        await db.runAsync(
          `DELETE FROM ${TABLES.rqCache} WHERE updated_at < ?`,
          now - opts.maxAge,
        );

        // Store buster + timestamp so restoreClient can return the full
        // PersistedClient shape. Mutations are deliberately omitted — the app
        // uses its own pending_mutations queue instead.
        const meta = JSON.stringify({ buster: client.buster, timestamp: client.timestamp });
        await db.runAsync(
          `INSERT INTO ${TABLES.meta} (key, value) VALUES ('rq_meta', ?) ` +
            `ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
          meta,
        );
      });
    },

    async restoreClient(): Promise<PersistedClient | undefined> {
      const db = await getDb();
      const now = Date.now();

      const metaRow = await db.getFirstAsync<{ value: string }>(
        `SELECT value FROM ${TABLES.meta} WHERE key = 'rq_meta'`,
      );

      // No meta row means the DB has never been persisted (cold install).
      // Return undefined so PersistQueryClientProvider treats it as a cold start.
      if (metaRow == null) return undefined;

      const { buster, timestamp } = JSON.parse(metaRow.value) as {
        buster: string;
        timestamp: number;
      };

      const rows = await db.getAllAsync<{ state: string }>(
        `SELECT state FROM ${TABLES.rqCache} WHERE updated_at >= ?`,
        now - opts.maxAge,
      );

      const queries = rows.map((r) => JSON.parse(r.state) as object);

      return {
        buster,
        timestamp,
        clientState: { queries: queries as PersistedClient["clientState"]["queries"], mutations: [] },
      };
    },

    async removeClient(): Promise<void> {
      const db = await getDb();
      await withTx(db, async () => {
        await db.runAsync(`DELETE FROM ${TABLES.rqCache}`);
        await db.runAsync(`DELETE FROM ${TABLES.meta} WHERE key = 'rq_meta'`);
      });
    },
  };
}
