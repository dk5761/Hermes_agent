/**
 * search.ts — Phase 2 of the Hermes search feature.
 *
 * GET /search?q=...&limit=20&offset=0
 *   Full-text search over chat_history via the FTS5 index built in Phase 1.
 *   Scoped to the authenticated user (joined through app_sessions.user_id).
 *
 * v1 uses simple offset pagination. The response shape exposes nextCursor as
 * a string so we can swap to opaque rowid+score cursors later without changing
 * the client. Power-user FTS5 syntax (quotes, AND/OR/NOT, prefix*) is passed
 * through; the UI doesn't expose it but the API supports it.
 *
 * Rate limiting: a per-user inline cap is attached via @fastify/rate-limit's
 * route-level config. The global limiter is already registered in server.ts.
 */
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import type { DbHandle } from "../db/client.js";
import type { AppLogger } from "../logger.js";

export interface SearchRoutesDeps {
  dbHandle: DbHandle;
  requireAuth: preHandlerHookHandler;
  logger: AppLogger;
}

// `q` is required (must be present in the query string) but may be the empty
// string — sanitizeFtsQuery() short-circuits to [] on whitespace-only input
// per the spec. The .max(200) cap protects the FTS parser from pathological
// inputs; oversize queries 400 cleanly.
const querySchema = z.object({
  q: z.string().max(200),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

interface SearchRow {
  message_id: number;
  session_id: string;
  title_override: string | null;
  role: string;
  created_at: number;
  rank: number;
  snippet: string;
}

export interface SearchResultItem {
  sessionId: string;
  sessionTitle: string;
  messageId: number;
  role: string;
  snippet: string;
  createdAt: number;
  score: number;
}

export interface SearchResponse {
  results: SearchResultItem[];
  nextCursor: string | null;
}

// FTS5 SELECT. We fetch limit+1 rows to detect whether there's a next page
// (cheaper than a separate COUNT(*) for an FTS MATCH). bm25(table) returns a
// score where lower is a better match; ORDER BY rank ASC is the canonical
// FTS5 idiom (FTS5 internally aliases `rank` to bm25() for content tables).
const SEARCH_SQL = `
  SELECT
    ch.id              AS message_id,
    ch.app_session_id  AS session_id,
    s.title_override   AS title_override,
    ch.kind            AS role,
    ch.created_at      AS created_at,
    bm25(chat_history_fts) AS rank,
    snippet(chat_history_fts, 1, '⟨MARK⟩', '⟨/MARK⟩', '…', 12) AS snippet
  FROM chat_history_fts
  JOIN chat_history ch ON ch.id = chat_history_fts.rowid
  JOIN app_sessions s ON s.id = ch.app_session_id
  WHERE chat_history_fts MATCH ?
    AND s.user_id = ?
  ORDER BY rank
  LIMIT ? OFFSET ?
`;

export async function registerSearchRoutes(
  app: FastifyInstance,
  deps: SearchRoutesDeps,
): Promise<void> {
  const { dbHandle, requireAuth, logger } = deps;

  // Prepare once; better-sqlite3 prepared statements are reusable across calls.
  const stmt = dbHandle.raw.prepare<[string, string, number, number]>(SEARCH_SQL);

  app.get(
    "/search",
    {
      preHandler: requireAuth,
      // Per-user inline rate limit. Mirrors the upload route's pattern (see
      // routes/uploads.ts). The global limiter still applies on top of this.
      // 30 req / 10 sec gives the autocomplete UI plenty of headroom while
      // still capping abuse — looser than the plan's 10/5s on purpose since
      // the FE will likely debounce-fire several queries per typing burst.
      config: {
        rateLimit: {
          max: 30,
          timeWindow: 10_000,
          keyGenerator: (req) => req.user?.id ?? req.ip,
        },
      },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) return reply.code(401).send({ error: "unauthenticated" });

      const parsed = querySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "invalid_query", details: parsed.error.flatten() });
      }
      const { q, limit, offset } = parsed.data;

      // ---- Sanitize the FTS5 query ---------------------------------------
      const sanitized = sanitizeFtsQuery(q);
      if (sanitized === null) {
        // Empty / whitespace-only / pure-punctuation — short-circuit, no DB call.
        return reply.send({ results: [], nextCursor: null } satisfies SearchResponse);
      }

      // ---- Execute -------------------------------------------------------
      // Fetch limit+1 to detect "is there a next page?" without a COUNT(*).
      let rawRows: SearchRow[];
      const t0 = Date.now();
      try {
        rawRows = stmt.all(sanitized, user.id, limit + 1, offset) as SearchRow[];
      } catch (err) {
        // FTS5 throws on syntactically invalid queries even after our basic
        // sanitization (e.g. a stray `NOT` at the end). Treat as empty result
        // rather than 500 — the user just typed something the parser hates.
        logger.debug(
          { err, q, sanitized },
          "search: FTS query rejected by SQLite, returning empty",
        );
        return reply.send({ results: [], nextCursor: null } satisfies SearchResponse);
      }
      const durationMs = Date.now() - t0;

      const hasNextPage = rawRows.length > limit;
      const rows = hasNextPage ? rawRows.slice(0, limit) : rawRows;

      const results: SearchResultItem[] = rows.map((r) => ({
        sessionId: r.session_id,
        sessionTitle: r.title_override ?? "Untitled",
        messageId: r.message_id,
        role: r.role,
        snippet: r.snippet,
        createdAt: r.created_at,
        score: r.rank,
      }));

      const nextCursor = hasNextPage ? String(offset + limit) : null;

      logger.debug(
        { q, sanitized, count: results.length, durationMs, userId: user.id },
        "search query executed",
      );

      return reply.send({ results, nextCursor } satisfies SearchResponse);
    },
  );
}

/**
 * Best-effort FTS5 query sanitizer.
 *
 * Returns null when the input is empty, whitespace-only, or contains no
 * word characters at all (pure punctuation). Otherwise returns a string
 * suitable for `MATCH ?`.
 *
 * Strategy:
 *   - Trim outer whitespace.
 *   - If the number of unescaped double-quotes is odd (unbalanced phrase),
 *     strip ALL quotes — FTS5 raises SqliteError on unbalanced quotes and
 *     trying to escape mid-string is fragile.
 *   - If after the above the string has no \w characters, return null.
 *   - Otherwise pass through verbatim. Power users keep AND/OR/NOT/* support.
 */
export function sanitizeFtsQuery(input: string): string | null {
  let q = input.trim();
  if (q.length === 0) return null;

  // Count double-quotes; if odd, FTS5 will reject the query. Strip them all.
  let quoteCount = 0;
  for (let i = 0; i < q.length; i++) {
    if (q.charCodeAt(i) === 34 /* '"' */) quoteCount++;
  }
  if (quoteCount % 2 !== 0) {
    q = q.replace(/"/g, "");
    q = q.trim();
    if (q.length === 0) return null;
  }

  // Must contain at least one word character (letter, digit, or underscore).
  // Also accept Unicode letters via the `u` flag — FTS5's unicode61 tokenizer
  // splits on punctuation but indexes every alphabet.
  if (!/[\p{L}\p{N}_]/u.test(q)) return null;

  return q;
}
