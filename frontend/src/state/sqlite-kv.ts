/**
 * sqliteKv — Zustand-compatible StateStorage backed by the SQLite `kv` table.
 *
 * Drop-in replacement for AsyncStorage in every Zustand `persist` block and
 * in call sites that use `AsyncStorage.getItem / setItem / removeItem` directly.
 * The async signatures match the AsyncStorage API so swaps are mechanical.
 *
 * Keys are stored verbatim — preserving the existing storage key strings is
 * required so the Phase 6 one-shot AsyncStorage → SQLite migration can copy
 * values under the same keys.
 */
import { type StateStorage } from "zustand/middleware";
import { getDb } from "@/db/sqlite";
import { TABLES } from "@/db/schema";

export const sqliteKv: StateStorage<Promise<void>> = {
  async getItem(key: string): Promise<string | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ value: string }>(
      `SELECT value FROM ${TABLES.kv} WHERE key = ?`,
      key,
    );
    return row?.value ?? null;
  },

  async setItem(key: string, value: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `INSERT INTO ${TABLES.kv} (key, value, updated_at) VALUES (?, ?, ?)` +
        ` ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      key,
      value,
      Date.now(),
    );
  },

  async removeItem(key: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`DELETE FROM ${TABLES.kv} WHERE key = ?`, key);
  },
};
