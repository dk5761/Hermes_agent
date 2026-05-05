/**
 * search API client — Phase 3 of the Hermes search feature.
 *
 * Thin wrapper over `apiFetch` for `GET /search?q=&limit=&offset=`. Mirrors the
 * shape of the Phase 2 backend response in `backend/src/routes/search.ts`.
 *
 * Pagination note: v1 the backend uses simple offset pagination, but the wire
 * field is named `nextCursor` so we can swap to opaque cursors later without
 * breaking callers. `nextCursor` is currently a stringified next-offset (e.g.
 * "20", "40"), so for now `useSearch` parses it via `Number(nextCursor)` and
 * passes that as `offset`. When/if the backend moves to opaque cursors, this
 * client signature stays the same and only `useSearch.queryFn` changes.
 *
 * Snippet markers: the backend wraps matched terms with the literal sentinels
 * `⟨MARK⟩` and `⟨/MARK⟩` (U+27E8 / U+27E9). These are non-HTML and won't
 * collide with markdown — Phase 4 will tokenize on them when rendering.
 */
import { apiFetch } from "./client";

export interface SearchResult {
  sessionId: string;
  sessionTitle: string;
  messageId: number;
  role: string;
  /** Snippet text containing `⟨MARK⟩...⟨/MARK⟩` pairs around matched terms. */
  snippet: string;
  /** Unix epoch seconds (matches backend chat_history.created_at). */
  createdAt: number;
  /** FTS5 bm25 score. Lower = better match. */
  score: number;
}

export interface SearchResponse {
  results: SearchResult[];
  /**
   * Stringified next-offset (e.g. "20") in v1, or `null` when there are no
   * more pages. Treat as opaque from the caller's perspective; `useSearch`
   * is the one place that parses it back to a number.
   */
  nextCursor: string | null;
}

export interface SearchOptions {
  limit?: number;
  offset?: number;
  signal?: AbortSignal;
}

export async function search(
  q: string,
  opts: SearchOptions = {},
): Promise<SearchResponse> {
  const { limit, offset, signal } = opts;
  return apiFetch<SearchResponse>("/search", {
    query: { q, limit, offset },
    signal,
  });
}
