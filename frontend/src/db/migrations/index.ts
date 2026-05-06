import type { SQLiteDatabase } from "expo-sqlite";

/** A single versioned migration. SQL may contain multiple statements. */
interface Migration {
  version: number;
  sql: string;
}

/**
 * Ordered list of all schema migrations.
 * Each entry is applied exactly once, in version order.
 * Never edit an existing entry — add a new one instead.
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE rq_cache (
  query_key TEXT PRIMARY KEY,
  state     TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX rq_cache_updated ON rq_cache(updated_at);

CREATE TABLE kv (
  key       TEXT PRIMARY KEY,
  value     TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE pending_mutations (
  id          TEXT PRIMARY KEY,
  enqueued_at INTEGER NOT NULL,
  retries     INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  kind        TEXT NOT NULL,
  payload     TEXT NOT NULL
);
CREATE INDEX pending_mutations_age ON pending_mutations(enqueued_at);

CREATE TABLE pending_sends (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  enqueued_at INTEGER NOT NULL,
  text        TEXT NOT NULL,
  attachments TEXT,
  status      TEXT NOT NULL,
  retries     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX pending_sends_session ON pending_sends(session_id, enqueued_at);

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
    `.trim(),
  },
];

/**
 * Ensures schema_version table exists, reads the current version, and applies
 * every pending migration inside its own transaction. Idempotent: safe to call
 * on every boot. A crash mid-migration leaves version unchanged so the same
 * migration retries on next boot.
 */
export async function runMigrations(db: SQLiteDatabase): Promise<void> {
  // schema_version is outside MIGRATIONS so it bootstraps itself.
  await db.execAsync(
    "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);",
  );

  const row = await db.getFirstAsync<{ version: number }>(
    "SELECT version FROM schema_version LIMIT 1",
  );

  let current = row?.version ?? 0;

  if (current === 0 && row === null) {
    // Fresh DB: insert the sentinel row so subsequent updates work.
    await db.runAsync("INSERT INTO schema_version (version) VALUES (0)");
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;

    await db.withTransactionAsync(async () => {
      await db.execAsync(migration.sql);
      await db.runAsync(
        "UPDATE schema_version SET version = ?",
        migration.version,
      );
    });

    current = migration.version;
    console.log(`[db] applied migration ${migration.version}`);
  }
}
