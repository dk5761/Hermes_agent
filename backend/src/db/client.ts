import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  db: Db;
  raw: Database.Database;
  close: () => void;
}

export function openDb(databaseUrl: string): DbHandle {
  const resolved = path.resolve(databaseUrl);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const raw = new Database(resolved);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  raw.pragma("synchronous = NORMAL");

  const db = drizzle(raw, { schema });

  return {
    db,
    raw,
    close: () => {
      raw.close();
    },
  };
}

// Apply any pending drizzle migrations against the open db. Idempotent —
// drizzle's migrator records applied entries in `__drizzle_migrations` and
// skips them on subsequent boots. The `migrations/` folder ships in source
// (and is copied into the container by the Dockerfile), so we resolve it
// relative to this file rather than process.cwd() to be robust to where the
// process is launched from.
export function runMigrations(db: Db): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = path.resolve(here, "migrations");
  if (!fs.existsSync(migrationsFolder)) {
    throw new Error(`migrations folder missing: ${migrationsFolder}`);
  }
  migrate(db, { migrationsFolder });
}
