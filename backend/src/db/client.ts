import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
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
