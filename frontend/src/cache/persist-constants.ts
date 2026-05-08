/**
 * Persistence constants shared between the TanStack Query persister and the
 * SQLite boot-hygiene pruner.
 *
 * Lives in its own module to break the cycle:
 *   db/sqlite.ts → cache/query-persister.ts → cache/sqlite-persister.ts → db/sqlite.ts
 * Both `sqlite.ts` (for hygiene) and `query-persister.ts` (for the persister
 * config) need `PERSIST_MAX_AGE`. Importing it from a leaf module keeps each
 * side cycle-free.
 *
 * Bump `PERSIST_BUSTER` when an API response shape changes — the next launch
 * wipes the rq_cache table once and repopulates from network.
 */

/** 7 days. Rows older than this are pruned on persist + at boot hygiene. */
export const PERSIST_MAX_AGE = 1000 * 60 * 60 * 24 * 7;

/** Cache version. Bump on shape-breaking API changes. */
// 2 — cron output rows now use ISO `createdAt` strings + a required `preview`;
// also flushes any pending/errored queries persisted under the old code path
// that triggered the "promise.then is not a function" hydration crash.
export const PERSIST_BUSTER = "2";
