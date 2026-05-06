import type { Query } from "@tanstack/react-query";
import { createSQLitePersister } from "./sqlite-persister";

/**
 * Persist the TanStack Query cache to SQLite so the app paints meaningfully
 * when launched offline. Each query is stored as a separate row, avoiding the
 * single-blob bottleneck and 6 MB ceiling of the AsyncStorage persister.
 *
 * Writes are batched inside a single transaction per `persistClient` call.
 * PersistQueryClientProvider already debounces calls to 1 s, so disk pressure
 * stays bounded even during long streaming turns.
 *
 * Cache key includes a version suffix; bump `PERSIST_BUSTER` when an API
 * response shape changes incompatibly. Bumping clears all rq_cache rows on
 * next launch via the buster-mismatch check in PersistQueryClientProvider.
 */

/** 7-day disk lifetime. Rows older than this are pruned on each persist call. */
export const PERSIST_MAX_AGE = 1000 * 60 * 60 * 24 * 7;

/** Bump to force a one-time cache wipe on next app launch. */
export const PERSIST_BUSTER = "1";

export const persister = createSQLitePersister({
  buster: PERSIST_BUSTER,
  maxAge: PERSIST_MAX_AGE,
});

/**
 * Selective persistence — drop queries that shouldn't revive from disk.
 *   - auth: security; never cache tokens or user payloads
 *   - uploads: per-blob progress is ephemeral
 *   - live-activity: device-state-bound (Live Activities)
 *   - provider-keys: catalog re-fetched on demand at the picker
 *
 * Passed to PersistQueryClientProvider's `dehydrateOptions`; TanStack calls
 * dehydrate() with this filter BEFORE invoking `persister.persistClient`, so
 * the persister receives only already-filtered queries.
 */
export const dehydrateOptions = {
  shouldDehydrateQuery: (q: Query): boolean => {
    const k = q.queryKey;
    if (!Array.isArray(k) || k.length === 0) return false;
    const root = k[0];
    if (root === "auth") return false;
    if (root === "uploads") return false;
    if (root === "live-activity") return false;
    if (root === "provider-keys") return false;
    return true;
  },
};
