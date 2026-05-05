/**
 * useSearch — Phase 3 of the Hermes search feature.
 *
 * Wraps the `/search` API in a TanStack `useInfiniteQuery` plus a 200ms
 * input debounce, plus an AsyncStorage-backed recent-queries MRU list.
 *
 * Cursor handling: backend `nextCursor` is currently a stringified next-
 * offset; we parse it via `Number(nextCursor)` for the next page's `offset`
 * arg. If/when the backend moves to opaque cursors, only the queryFn here
 * needs to change (the `search()` client and consumers stay put).
 *
 * Cancelation: TanStack passes an AbortSignal into the queryFn, which we
 * forward to `search()`. Switching `debouncedQuery` aborts the in-flight
 * request automatically.
 *
 * Hydration: the recent-searches store is hydrated lazily on the hook's
 * first mount, in line with how chat-store / notifications-inbox are
 * hydrated from `_layout.tsx`. Hydrating from the hook (instead of from
 * `_layout.tsx`) keeps the cold-start critical path lean — recent searches
 * are only ever read from the search modal.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";

import { search, type SearchResponse, type SearchResult } from "@/api/search";
import { useRecentSearches } from "@/state/recent-searches";

const DEBOUNCE_MS = 200;
const PAGE_LIMIT = 20;

export interface UseSearchResult {
  /** The current input value, updated synchronously on every keystroke. */
  query: string;
  setQuery: (q: string) => void;
  /** Flat list of results across every fetched page. */
  results: SearchResult[];
  loading: boolean;
  error: Error | null;
  hasMore: boolean;
  loadMore: () => void;
  recentQueries: string[];
  clearRecent: () => void;
  /**
   * Push the *current* (un-debounced) query onto the recent-searches MRU.
   * Intended to be called when the user taps a result. No-op for empty /
   * whitespace-only queries.
   */
  commitToRecent: () => void;
}

/**
 * Lightweight debounce hook. Returns `value` after `delay` ms of quiescence.
 * Inlined to avoid pulling in lodash.debounce.
 */
function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

export function useSearch(): UseSearchResult {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, DEBOUNCE_MS);
  const trimmedDebounced = debouncedQuery.trim();
  const enabled = trimmedDebounced.length > 0;

  // Hydrate the recent-searches store on first mount. Idempotent — the
  // store's `hydrate()` short-circuits when already hydrated, so it's safe
  // for multiple hook instances to fire this in parallel.
  useEffect(() => {
    void useRecentSearches.getState().hydrate();
  }, []);

  // Subscribe to recent searches via the store selector.
  const recentQueries = useRecentSearches((s) => s.recent);
  const clearRecent = useRecentSearches((s) => s.clear);

  // Stable ref to the current (un-debounced) query for `commitToRecent`,
  // so the returned callback identity doesn't change on every keystroke.
  const queryRef = useRef(query);
  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  const infinite = useInfiniteQuery<
    SearchResponse,
    Error,
    { pages: SearchResponse[]; pageParams: Array<number | undefined> },
    readonly ["search", string],
    number | undefined
  >({
    queryKey: ["search", trimmedDebounced] as const,
    enabled,
    initialPageParam: undefined,
    queryFn: ({ pageParam, signal }) =>
      search(trimmedDebounced, {
        limit: PAGE_LIMIT,
        offset: pageParam,
        signal,
      }),
    getNextPageParam: (last) => {
      if (last.nextCursor === null) return undefined;
      const n = Number(last.nextCursor);
      return Number.isFinite(n) ? n : undefined;
    },
    staleTime: 30_000,
    gcTime: 60_000,
    retry: 1,
  });

  const results = useMemo<SearchResult[]>(() => {
    if (!enabled || !infinite.data) return [];
    return infinite.data.pages.flatMap((p) => p.results);
  }, [enabled, infinite.data]);

  const hasMore = useMemo(() => {
    if (!enabled || !infinite.data) return false;
    return infinite.data.pages.at(-1)?.nextCursor != null;
  }, [enabled, infinite.data]);

  const loadMore = useCallback(() => {
    if (!hasMore) return;
    if (infinite.isFetching || infinite.isFetchingNextPage) return;
    void infinite.fetchNextPage();
  }, [hasMore, infinite]);

  const commitToRecent = useCallback(() => {
    const q = queryRef.current.trim();
    if (q.length === 0) return;
    useRecentSearches.getState().push(q);
  }, []);

  // `loading` is true while *any* fetch is in flight for an enabled query.
  // We deliberately do not set loading=true for an empty query; consumers
  // expect a clean idle state (results=[], loading=false) when there's no
  // input.
  const loading = enabled && (infinite.isPending || infinite.isFetching);

  return {
    query,
    setQuery,
    results,
    loading,
    error: infinite.error,
    hasMore,
    loadMore,
    recentQueries,
    clearRecent,
    commitToRecent,
  };
}
