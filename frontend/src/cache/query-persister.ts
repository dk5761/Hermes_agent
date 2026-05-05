import AsyncStorage from "@react-native-async-storage/async-storage";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import type { Query } from "@tanstack/react-query";

/**
 * Persist the TanStack Query cache to AsyncStorage so the app paints
 * meaningfully when launched offline. Writes are throttled to 1s so a long
 * streaming turn doesn't hammer disk.
 *
 * Cache key includes a version suffix; bump when an API response shape
 * changes incompatibly. The PersistQueryClientProvider's `buster` prop is
 * the runtime equivalent — bumping it triggers a one-time wipe on next
 * launch.
 */
export const persister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: "hermes.rq.cache.v1",
  throttleTime: 1000,
});

/** 7-day disk lifetime. Older entries dropped on hydrate. */
export const PERSIST_MAX_AGE = 1000 * 60 * 60 * 24 * 7;

/**
 * Selective persistence — drop queries that shouldn't revive from disk.
 *   - auth: security; never cache tokens or user payloads
 *   - uploads: per-blob progress is ephemeral
 *   - live-activity: device-state-bound (Live Activities)
 *   - provider-keys: catalog re-fetched on demand at the picker
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

/** Bump to force a one-time cache wipe on next app launch. */
export const PERSIST_BUSTER = "1";
