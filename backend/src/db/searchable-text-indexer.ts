/**
 * searchable-text-indexer.ts
 *
 * Boot-time backfill indexer for the search_text FTS column.
 *
 * Idempotent: only processes rows where search_text IS NULL. On first deploy
 * with an existing DB this may be all rows; subsequent boots are a no-op
 * (the NULL count check exits immediately).
 *
 * Strategy on a non-empty backfill:
 *   1. Drop all 3 FTS triggers (AI / AD / AU). New chat_history rows written
 *      during the backfill window will not be auto-indexed; the rebuild step
 *      below covers them.
 *   2. UPDATE chat_history rows in batches with extracted search_text.
 *      With triggers dropped, no FTS-side work happens per row.
 *   3. Run `INSERT INTO chat_history_fts(chat_history_fts) VALUES('rebuild')`
 *      once. SQLite walks chat_history.search_text and rebuilds the FTS
 *      index from scratch — this also clears any prior corruption.
 *   4. Recreate all 3 triggers from the canonical SQL constants below.
 *
 * Why rebuild instead of per-row INSERT into chat_history_fts:
 *   The AFTER INSERT trigger fires when chat_history rows are originally
 *   created (with search_text = NULL → COALESCE → ""). When we later UPDATE
 *   those rows during backfill and try to INSERT a second FTS row with the
 *   same rowid, SQLite raises SQLITE_CORRUPT_VTAB ("database disk image is
 *   malformed"). Rebuild side-steps this by clearing the FTS index entirely
 *   before re-walking the content table.
 */

import type Database from "better-sqlite3";
import type { AppLogger } from "../logger.js";
import { extractSearchableText } from "./searchable-text.js";

export interface IndexerOptions {
  /** Number of rows per transaction batch. Default: 1000. */
  batchSize?: number;
  /** Log progress every N rows processed. Default: 5000. */
  logEvery?: number;
}

export interface IndexerStats {
  totalRows: number;
  processedRows: number;
  skippedRows: number;
  durationMs: number;
  /** Whether the FTS index was fully rebuilt (true) or left untouched (false, when no rows needed backfilling). */
  rebuilt: boolean;
}

interface ChatHistoryRow {
  id: number;
  app_session_id: string;
  kind: string;
  payload_json: string;
}

// Canonical trigger SQL — must EXACTLY match what's in the migration so that
// recreate-after-backfill produces an identical trigger. If the migration
// changes, mirror the change here.
const TRIGGER_AI_SQL = `
CREATE TRIGGER chat_history_fts_ai AFTER INSERT ON chat_history BEGIN
  INSERT INTO chat_history_fts(rowid, app_session_id, search_text)
    VALUES (new.id, new.app_session_id, COALESCE(new.search_text, ''));
END
`.trim();

const TRIGGER_AD_SQL = `
CREATE TRIGGER chat_history_fts_ad AFTER DELETE ON chat_history BEGIN
  INSERT INTO chat_history_fts(chat_history_fts, rowid, app_session_id, search_text)
    VALUES('delete', old.id, old.app_session_id, COALESCE(old.search_text, ''));
END
`.trim();

const TRIGGER_AU_SQL = `
CREATE TRIGGER chat_history_fts_au AFTER UPDATE ON chat_history BEGIN
  INSERT INTO chat_history_fts(chat_history_fts, rowid, app_session_id, search_text)
    VALUES('delete', old.id, old.app_session_id, COALESCE(old.search_text, ''));
  INSERT INTO chat_history_fts(rowid, app_session_id, search_text)
    VALUES (new.id, new.app_session_id, COALESCE(new.search_text, ''));
END
`.trim();

/**
 * Backfill search_text for all chat_history rows where it is currently NULL,
 * then rebuild the FTS index from scratch.
 *
 * Takes the raw better-sqlite3 Database (not the Drizzle wrapper) because we
 * need to execute raw DDL (DROP/CREATE TRIGGER, FTS rebuild command) and use
 * prepared statements directly for performance.
 */
export async function backfillSearchIndex(
  raw: Database.Database,
  log: AppLogger,
  opts?: IndexerOptions,
): Promise<IndexerStats> {
  const batchSize = opts?.batchSize ?? 1000;
  const logEvery = opts?.logEvery ?? 5000;
  const t0 = Date.now();

  // ---- 1. Count rows that need backfilling --------------------------------
  const countResult = raw
    .prepare("SELECT count(*) AS n FROM chat_history WHERE search_text IS NULL")
    .get() as { n: number };
  const totalRows = countResult.n;

  if (totalRows === 0) {
    log.info({ totalRows: 0 }, "search index up to date");
    return {
      totalRows: 0,
      processedRows: 0,
      skippedRows: 0,
      durationMs: Date.now() - t0,
      rebuilt: false,
    };
  }

  log.info({ totalRows }, "search index backfill starting");

  // ---- 2. Drop all 3 triggers --------------------------------------------
  // We need to drop AI as well because each chat_history row already has a
  // matching FTS row from when it was originally inserted (with empty content).
  // Re-inserting via UPDATE-driven AFTER UPDATE trigger would corrupt FTS.
  // Cleanest path: drop everything, do the UPDATEs, rebuild FTS once.
  raw.exec("DROP TRIGGER IF EXISTS chat_history_fts_ai");
  raw.exec("DROP TRIGGER IF EXISTS chat_history_fts_ad");
  raw.exec("DROP TRIGGER IF EXISTS chat_history_fts_au");

  let processedRows = 0;
  let skippedRows = 0;
  let rebuilt = false;

  try {
    // ---- 3. Prepared statements ------------------------------------------
    const selectBatch = raw.prepare<[number]>(
      "SELECT id, app_session_id, kind, payload_json FROM chat_history WHERE search_text IS NULL ORDER BY id LIMIT ?",
    );

    const updateSearchText = raw.prepare<[string, number]>(
      "UPDATE chat_history SET search_text = ? WHERE id = ?",
    );

    // ---- 4. Batch UPDATE chat_history -----------------------------------
    const runBatch = raw.transaction((rows: ChatHistoryRow[]) => {
      for (const row of rows) {
        let searchText: string;
        try {
          const parsed: unknown = JSON.parse(row.payload_json);
          // null search_text means "no indexable text" — store as empty string
          // so this row is not re-processed on next boot.
          searchText = extractSearchableText(row.kind, parsed) ?? "";
        } catch {
          log.debug(
            { id: row.id, kind: row.kind },
            "search backfill: skipping row — payload parse failed",
          );
          skippedRows++;
          searchText = "";
        }
        updateSearchText.run(searchText, row.id);
        processedRows++;
      }
    });

    let lastLoggedAt = 0;

    // Since UPDATE removes rows from the NULL window, we always select the
    // first `batchSize` rows that still have search_text IS NULL.
    while (true) {
      const batch = selectBatch.all(batchSize) as ChatHistoryRow[];
      if (batch.length === 0) break;
      runBatch(batch);

      const total = processedRows;
      if (total - lastLoggedAt >= logEvery) {
        log.info(
          { processed: total, total: totalRows, durationMs: Date.now() - t0 },
          "search index backfill progress",
        );
        lastLoggedAt = total;
      }

      // Yield to event loop between batches so we don't starve other boot work.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    // ---- 5. Rebuild FTS from scratch -------------------------------------
    // This walks chat_history.search_text once and rebuilds the FTS index.
    // Also clears any pre-existing corruption (which is how we got here in
    // the first place if a prior backfill aborted halfway).
    log.info("search index backfill: rebuilding FTS from chat_history");
    raw.exec("INSERT INTO chat_history_fts(chat_history_fts) VALUES('rebuild')");
    rebuilt = true;
  } finally {
    // ---- 6. Recreate triggers (always — even if backfill threw) ---------
    raw.exec(TRIGGER_AI_SQL);
    raw.exec(TRIGGER_AD_SQL);
    raw.exec(TRIGGER_AU_SQL);
  }

  // ---- 7. Final stats ----------------------------------------------------
  const durationMs = Date.now() - t0;
  const ftsCountResult = raw
    .prepare("SELECT count(*) AS n FROM chat_history_fts_docsize")
    .get() as { n: number };

  log.info(
    {
      processedRows,
      skippedRows,
      ftsRows: ftsCountResult.n,
      durationMs,
    },
    `search index backfilled: ${processedRows} rows in ${durationMs}ms (skipped ${skippedRows})`,
  );

  return { totalRows, processedRows, skippedRows, durationMs, rebuilt };
}
