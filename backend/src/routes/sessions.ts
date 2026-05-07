import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, inArray, isNotNull, max, sql } from "drizzle-orm";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { appSessions, chatHistory, wsEvents } from "../db/schema.js";
import type { HermesHttpClient } from "../hermes/http-client.js";
import type { HermesWsPool } from "../hermes/ws-pool.js";
import type { AppLogger } from "../logger.js";
import { nextBranchTitle } from "../sessions/branch-title.js";
import {
  ensureHermesSession,
  EnsureHermesSessionError,
} from "../sessions/ensure-hermes-session.js";
import { loadSessionUsage } from "../usage/session-usage.js";
import { loadHistoryWindow } from "../ws/chat-history.js";
import { HermesRpcError } from "../hermes/types.js";

/**
 * Issues a slash.exec call with one transparent retry on the
 * "slash worker exited" error path (Hermes RPC code 5030, message
 * containing "slash worker"). Hermes' dashboard caches a long-lived
 * subprocess per session for slash commands; when that subprocess dies
 * (idle timeout, restart of the parent, manual kill, hot-patch) the
 * first call to `worker.run()` throws and the dashboard clears the
 * stale slot — making the SECOND call succeed by spawning a fresh
 * worker. Retrying on the gateway side hides that handshake from the
 * client.
 *
 * Other RPC errors are surfaced unchanged. Network / non-RPC errors
 * are surfaced unchanged (those are real outages, not stale handles).
 */
async function slashExecWithRetry(
  client: ReturnType<HermesWsPool["getOrCreateShared"]>,
  params: { session_id: string; command: string },
  timeoutMs: number,
): Promise<{ output?: string; warning?: string }> {
  const once = () =>
    Promise.race([
      client.request("slash.exec", params),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("upstream_request_timeout:slash.exec")),
          timeoutMs,
        ).unref(),
      ),
    ]) as Promise<{ output?: string; warning?: string }>;

  try {
    return await once();
  } catch (err) {
    const isStaleWorker =
      err instanceof HermesRpcError &&
      err.code === 5030 &&
      /slash worker/i.test(err.message);
    if (!isStaleWorker) throw err;
    // Dashboard has cleared the slot now; the next call spawns a fresh
    // worker that loads any on-disk patches we might have applied since
    // the previous worker booted.
    return await once();
  }
}

const PREVIEW_EVENT_TYPES = ["message.complete", "message.delta"] as const;
const PREVIEW_MAX_CHARS = 120;

export interface SessionsRoutesDeps {
  db: Db;
  requireAuth: preHandlerHookHandler;
  hermesHttp: HermesHttpClient;
  wsPool: HermesWsPool;
  logger: AppLogger;
  /** Absolute path to the blob root (STORAGE_LOCAL_ROOT). Used to unlink audio blobs on session delete. */
  blobRoot: string;
}

const createBody = z.object({
  title: z.string().min(1).max(200).optional(),
});
const patchBody = z
  .object({
    title: z.string().min(1).max(200).optional(),
    archived: z.boolean().optional(),
  })
  .refine((v) => v.title !== undefined || v.archived !== undefined, {
    message: "no fields to update",
  });
const idParams = z.object({ id: z.string().min(1) });
const searchQuery = z.object({ q: z.string().min(1).max(200) });
// Pagination params for GET /sessions/:id/messages. `z.coerce` handles the
// fact that fastify hands us strings from the query string; we still want
// integers downstream. `before` and `around` are mutually exclusive — we
// enforce that in the handler so the 400 response stays explicit.
const messagesQuery = z.object({
  limit: z.coerce.number().int().positive().optional(),
  before: z.coerce.number().int().positive().optional(),
  around: z.coerce.number().int().positive().optional(),
});
const MESSAGES_DEFAULT_LIMIT = 50;
const MESSAGES_MAX_LIMIT = 100;
const branchBody = z.object({
  title: z.string().min(1).max(200).optional(),
});
// Hard cap for the slash.exec round-trip. The shared ws client also has its
// own configured timeout, but we layer a defensive 30s deadline here so a
// hung Hermes can't pin the request thread indefinitely.
const BRANCH_SLASH_TIMEOUT_MS = 30_000;
const modelOverrideBody = z.union([
  z.object({
    clear: z.literal(true),
  }),
  z.object({
    provider: z.string().min(1).max(80),
    model: z.string().min(1).max(200),
  }),
]);

export async function registerSessionsRoutes(
  app: FastifyInstance,
  deps: SessionsRoutesDeps,
): Promise<void> {
  const { db, requireAuth, hermesHttp, wsPool, logger, blobRoot } = deps;

  app.get("/sessions", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: "unauthenticated" });

    const rows = await db
      .select()
      .from(appSessions)
      .where(eq(appSessions.userId, user.id))
      .orderBy(desc(appSessions.updatedAt));

    // Hermes' tui_gateway session_id (8-char hex from session.create) lives in
    // a different namespace from /api/sessions (timestamp ids). Fetching by
    // tui_gateway id 404s. Derive preview from our own ws_events log instead.
    const previews = await loadPreviewsForSessions(
      db,
      rows.map((r) => r.id),
    );

    const enriched = rows.map((row) => ({
      id: row.id,
      hermesSessionId: row.hermesSessionId,
      title: row.titleOverride ?? "Untitled",
      archived: row.archivedAt !== null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      preview: previews.get(row.id) ?? null,
      modelOverride: row.modelOverride,
      providerOverride: row.providerOverride,
      // Lineage pointer for branched sessions; null for root chats. Mobile
      // uses this to paint a "branched from X" chip and group children
      // under their parent.
      parentAppSessionId: row.parentAppSessionId,
    }));
    return reply.send({ sessions: enriched });
  });

  app.post("/sessions", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: "unauthenticated" });
    const parsed = createBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    }
    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(appSessions).values({
      id,
      userId: user.id,
      hermesSessionId: null,
      titleOverride: parsed.data.title ?? null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    return reply.code(201).send({
      id,
      title: parsed.data.title ?? null,
      hermesSessionId: null,
      archived: false,
      createdAt: now,
      updatedAt: now,
    });
  });

  app.patch("/sessions/:id", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: "unauthenticated" });
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_params" });
    const body = patchBody.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", details: body.error.flatten() });
    }

    const rows = await db
      .select()
      .from(appSessions)
      .where(and(eq(appSessions.id, params.data.id), eq(appSessions.userId, user.id)))
      .limit(1);
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: "not_found" });

    const now = Math.floor(Date.now() / 1000);
    const update: Partial<typeof appSessions.$inferInsert> = { updatedAt: now };
    if (body.data.title !== undefined) update.titleOverride = body.data.title;
    if (body.data.archived !== undefined) {
      update.archivedAt = body.data.archived ? now : null;
    }
    await db.update(appSessions).set(update).where(eq(appSessions.id, row.id));
    return reply.send({ id: row.id, updated: true });
  });

  // Per-session model override. PUT { provider, model } sets it; PUT { clear: true }
  // removes it. Override takes effect on the next chat.send (gateway-ws issues a
  // `config.set` to Hermes for that session before forwarding prompt.submit).
  app.put(
    "/sessions/:id/model",
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = request.user;
      if (!user) return reply.code(401).send({ error: "unauthenticated" });
      const params = idParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "invalid_params" });
      const body = modelOverrideBody.safeParse(request.body ?? {});
      if (!body.success) {
        return reply
          .code(400)
          .send({ error: "invalid_body", details: body.error.flatten() });
      }

      const rows = await db
        .select()
        .from(appSessions)
        .where(and(eq(appSessions.id, params.data.id), eq(appSessions.userId, user.id)))
        .limit(1);
      const row = rows[0];
      if (!row) return reply.code(404).send({ error: "not_found" });

      const now = Math.floor(Date.now() / 1000);
      const update: Partial<typeof appSessions.$inferInsert> = { updatedAt: now };
      if ("clear" in body.data) {
        update.modelOverride = null;
        update.providerOverride = null;
      } else {
        update.modelOverride = body.data.model;
        update.providerOverride = body.data.provider;
      }
      await db.update(appSessions).set(update).where(eq(appSessions.id, row.id));
      return reply.send({
        id: row.id,
        modelOverride: update.modelOverride ?? null,
        providerOverride: update.providerOverride ?? null,
      });
    },
  );

  app.delete("/sessions/:id", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: "unauthenticated" });
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_params" });

    const rows = await db
      .select()
      .from(appSessions)
      .where(and(eq(appSessions.id, params.data.id), eq(appSessions.userId, user.id)))
      .limit(1);
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: "not_found" });

    if (row.hermesSessionId) {
      try {
        await hermesHttp.deleteSession(row.hermesSessionId);
      } catch (err) {
        logger.warn({ err, hsid: row.hermesSessionId }, "upstream delete failed; continuing");
      }
    }

    // Collect audio blob paths before deleting rows so we can clean up files.
    // chat_history rows cascade-delete with the app_session row (FK onDelete:
    // "cascade"), so we SELECT first, delete the session row, then unlink files.
    const audioRows = await db
      .select({ audioBlobPath: chatHistory.audioBlobPath })
      .from(chatHistory)
      .where(
        and(
          eq(chatHistory.appSessionId, row.id),
          isNotNull(chatHistory.audioBlobPath),
        ),
      );

    await db.delete(appSessions).where(eq(appSessions.id, row.id));

    // Best-effort unlink — log warnings on failure but don't abort.
    for (const r of audioRows) {
      if (!r.audioBlobPath) continue;
      const filePath = path.join(blobRoot, r.audioBlobPath);
      try {
        await fsp.unlink(filePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          logger.warn({ err, filePath }, "session delete: audio blob unlink failed");
        }
      }
    }

    return reply.send({ id: row.id, deleted: true });
  });

  app.get("/sessions/search", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: "unauthenticated" });
    const parsed = searchQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query" });

    const userRows = await db
      .select({ id: appSessions.id, hermesSessionId: appSessions.hermesSessionId })
      .from(appSessions)
      .where(eq(appSessions.userId, user.id));
    const ownedHermesIds = new Set(
      userRows.map((r) => r.hermesSessionId).filter((v): v is string => typeof v === "string"),
    );

    let upstream: unknown;
    try {
      upstream = await hermesHttp.searchSessions(parsed.data.q);
    } catch (err) {
      logger.warn({ err }, "upstream search failed");
      return reply.send({ results: [] });
    }
    const filtered = filterSearchResultsByOwnership(upstream, ownedHermesIds);
    return reply.send(filtered);
  });

  // Aggregated token usage + computed cost for a single session. Sums across
  // every assistant.message row's `usage` block and groups by model. Cost is
  // derived locally from a price table (see usage/model-prices.ts) since
  // Hermes ships rows with cost_status="unknown".
  app.get(
    "/sessions/:id/usage",
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = request.user;
      if (!user) return reply.code(401).send({ error: "unauthenticated" });
      const params = idParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "invalid_params" });

      const ownership = await db
        .select({ id: appSessions.id })
        .from(appSessions)
        .where(and(eq(appSessions.id, params.data.id), eq(appSessions.userId, user.id)))
        .limit(1);
      if (!ownership[0]) return reply.code(404).send({ error: "not_found" });

      const usage = await loadSessionUsage(db, params.data.id);
      return reply.send(usage);
    },
  );

  app.get(
    "/sessions/:id/messages",
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = request.user;
      if (!user) return reply.code(401).send({ error: "unauthenticated" });
      const params = idParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "invalid_params" });
      const query = messagesQuery.safeParse(request.query ?? {});
      if (!query.success) {
        return reply
          .code(400)
          .send({ error: "invalid_query", details: query.error.flatten() });
      }
      if (query.data.before !== undefined && query.data.around !== undefined) {
        return reply.code(400).send({
          error: "invalid_params",
          details: "before and around are mutually exclusive",
        });
      }

      const ownership = await db
        .select({ id: appSessions.id })
        .from(appSessions)
        .where(and(eq(appSessions.id, params.data.id), eq(appSessions.userId, user.id)))
        .limit(1);
      if (!ownership[0]) return reply.code(404).send({ error: "not_found" });

      // Server-side cap; loadHistoryWindow also enforces this defensively.
      const limit = Math.min(
        MESSAGES_MAX_LIMIT,
        query.data.limit ?? MESSAGES_DEFAULT_LIMIT,
      );

      // Cold-load a window of narrative from chat_history (permanent, never
      // swept). Returns rich rows (user, assistant, tool, reasoning, etc.)
      // sorted ascending by id; `hasBefore`/`hasAfter` tell the client whether
      // older/newer pages exist beyond the returned set. Build opts without
      // explicit `undefined` keys — exactOptionalPropertyTypes is enabled.
      const opts: Parameters<typeof loadHistoryWindow>[2] = { limit };
      if (query.data.before !== undefined) opts.before = query.data.before;
      if (query.data.around !== undefined) opts.around = query.data.around;
      const result = await loadHistoryWindow(db, params.data.id, opts);
      return reply.send({
        rows: result.rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          createdAt: r.createdAt,
          payload: r.payload,
          // Audio fields — null for text-only rows. audioBlobUrl is the
          // relative path that the mobile client fetches (prefixed with
          // API_URL on the frontend).
          ...(r.audioBlobUrl !== null ? { audioBlobUrl: r.audioBlobUrl } : {}),
          ...(r.audioDurationMs !== null ? { audioDurationMs: r.audioDurationMs } : {}),
          ...(r.transcriptionStatus !== null ? { transcriptionStatus: r.transcriptionStatus } : {}),
          ...(r.transcriptionError !== null ? { transcriptionError: r.transcriptionError } : {}),
          ...(r.audioPeaks !== null ? { audioPeaks: r.audioPeaks } : {}),
        })),
        hasBefore: result.hasBefore,
        hasAfter: result.hasAfter,
      });
    },
  );

  // POST /sessions/:id/reload-mcp — runs Hermes' `/reload-mcp` slash command
  // for this session, reloading any MCP servers attached to it. Maps the
  // app session to its hermes session, then dispatches via slash.exec.
  app.post(
    "/sessions/:id/reload-mcp",
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = request.user;
      if (!user) return reply.code(401).send({ error: "unauthenticated" });
      const params = idParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "invalid_params" });

      const rows = await db
        .select({
          id: appSessions.id,
          hermesSessionId: appSessions.hermesSessionId,
        })
        .from(appSessions)
        .where(and(eq(appSessions.id, params.data.id), eq(appSessions.userId, user.id)))
        .limit(1);
      const row = rows[0];
      if (!row) return reply.code(404).send({ error: "not_found" });

      let hermesSessionId: string;
      try {
        hermesSessionId = await ensureHermesSession({
          db,
          wsPool,
          appSessionId: row.id,
          logger,
        });
      } catch (err) {
        const reason = err instanceof EnsureHermesSessionError ? err.reason : "session_create_failed";
        logger.warn({ err, appSessionId: row.id }, "reload-mcp: ensureHermesSession failed");
        return reply.code(503).send({ error: "ensure_session_failed", reason });
      }

      const client = wsPool.getOrCreateShared();
      try {
        const result = await slashExecWithRetry(
          client,
          { session_id: hermesSessionId, command: "/reload-mcp" },
          BRANCH_SLASH_TIMEOUT_MS,
        );
        return reply.send({
          output: typeof result?.output === "string" ? result.output : "",
          warning: typeof result?.warning === "string" ? result.warning : null,
        });
      } catch (err) {
        logger.warn({ err, appSessionId: row.id }, "reload-mcp slash.exec failed");
        return reply.code(503).send({
          error: "slash_failed",
          message: err instanceof Error ? err.message : "slash command failed",
        });
      }
    },
  );

  // POST /sessions/:id/branch — fork the current Hermes conversation. We
  // dispatch Hermes' built-in `/branch <title>` slash command (which copies
  // the conversation upstream and returns the new Hermes session_id), then
  // mirror the lineage on our side: a fresh app_session row + a per-row copy
  // of chat_history so the branched chat reads back the full prior narrative.
  // Inherits model/provider override so the branch keeps the user's choice.
  app.post(
    "/sessions/:id/branch",
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = request.user;
      if (!user) return reply.code(401).send({ error: "unauthenticated" });
      const params = idParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "invalid_params" });
      const body = branchBody.safeParse(request.body ?? {});
      if (!body.success) {
        return reply
          .code(400)
          .send({ error: "invalid_body", details: body.error.flatten() });
      }

      const rows = await db
        .select({
          id: appSessions.id,
          hermesSessionId: appSessions.hermesSessionId,
          titleOverride: appSessions.titleOverride,
          modelOverride: appSessions.modelOverride,
          providerOverride: appSessions.providerOverride,
        })
        .from(appSessions)
        .where(and(eq(appSessions.id, params.data.id), eq(appSessions.userId, user.id)))
        .limit(1);
      const parent = rows[0];
      if (!parent) return reply.code(404).send({ error: "not_found" });

      let parentHermesSessionId: string;
      try {
        parentHermesSessionId = await ensureHermesSession({
          db,
          wsPool,
          appSessionId: parent.id,
          logger,
        });
      } catch (err) {
        const reason = err instanceof EnsureHermesSessionError ? err.reason : "session_create_failed";
        logger.warn({ err, appSessionId: parent.id }, "branch: ensureHermesSession failed");
        return reply.code(503).send({ error: "ensure_session_failed", reason });
      }

      // Resolve final title. Body wins; otherwise auto-suffix against this
      // user's existing branches of THIS parent (not global, not other users).
      let finalTitle: string;
      if (body.data.title !== undefined) {
        finalTitle = body.data.title;
      } else {
        const siblings = await db
          .select({ title: appSessions.titleOverride })
          .from(appSessions)
          .where(
            and(
              eq(appSessions.userId, user.id),
              eq(appSessions.parentAppSessionId, parent.id),
            ),
          );
        const existing = new Set<string>();
        for (const s of siblings) {
          if (s.title !== null) existing.add(s.title);
        }
        finalTitle = nextBranchTitle(parent.titleOverride, existing);
      }

      const command = `/branch ${finalTitle}`;
      const client = wsPool.getOrCreateShared();

      // Layer an explicit deadline on top of the ws client's own timeout so
      // a stuck Hermes can't pin the request handler beyond 30s.
      let result: { output?: string; warning?: string };
      try {
        result = await slashExecWithRetry(
          client,
          { session_id: parentHermesSessionId, command },
          BRANCH_SLASH_TIMEOUT_MS,
        );
      } catch (err) {
        logger.warn({ err, appSessionId: parent.id }, "branch slash.exec failed");
        return reply.code(503).send({
          error: "slash_failed",
          message: err instanceof Error ? err.message : "slash command failed",
        });
      }

      // Parse the new Hermes session id out of the markdown response. Two
      // different Hermes implementations emit slightly different outputs:
      //   - gateway/run.py:  `Branch: \`<id>\`` (backticked, agent context)
      //   - cli.py:          `Branch session:   <id>` (plain, slash-worker)
      // The slash.exec path goes through the slash-worker (cli.py), so the
      // un-backticked variant is what we hit in practice. The alternation
      // handles both for forward compatibility.
      const output = typeof result.output === "string" ? result.output : "";
      const m =
        /Branch session:\s+([A-Za-z0-9_]+)/.exec(output) ??
        /Branch:\s*`([^`]+)`/.exec(output);
      if (!m || !m[1]) {
        logger.error(
          { appSessionId: parent.id, output },
          "branch slash.exec returned no parseable session id",
        );
        return reply.code(502).send({
          error: "branch_parse_failed",
          message: "Hermes /branch did not return a recognisable session id.",
        });
      }
      const newHermesId: string = m[1];

      // Atomically create the branch app_session + clone chat_history so the
      // FTS5 AI trigger fires per-row and the branch reads back the same
      // narrative the parent had at fork time. better-sqlite3 transactions
      // are synchronous: do NOT await inside the callback.
      const newAppId = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);
      try {
        db.transaction((tx) => {
          tx.insert(appSessions)
            .values({
              id: newAppId,
              userId: user.id,
              hermesSessionId: newHermesId,
              titleOverride: finalTitle,
              archivedAt: null,
              modelOverride: parent.modelOverride,
              providerOverride: parent.providerOverride,
              createdAt: now,
              updatedAt: now,
              parentAppSessionId: parent.id,
            })
            .run();
          // Raw INSERT…SELECT preserves search_text so the chat_history_fts_ai
          // trigger indexes the branch's rows with the same content the
          // parent already had.
          tx.run(sql`
            INSERT INTO chat_history (app_session_id, kind, payload_json, created_at, search_text)
            SELECT ${newAppId}, kind, payload_json, created_at, search_text
            FROM chat_history
            WHERE app_session_id = ${parent.id}
          `);
        });
      } catch (err) {
        // slash.exec already succeeded → the upstream Hermes session exists
        // but no app_session points at it. Log loudly so the upstream id is
        // recoverable for manual cleanup; we deliberately don't ship a janitor
        // for what should be vanishingly rare.
        logger.error(
          {
            parentAppSessionId: parent.id,
            orphanHermesSessionId: newHermesId,
            err,
          },
          "branch DB write failed; Hermes session orphaned",
        );
        return reply.code(503).send({
          error: "branch_db_write_failed",
          message: "Branch created upstream but local persistence failed.",
        });
      }

      return reply.send({
        id: newAppId,
        title: finalTitle,
        hermesSessionId: newHermesId,
        parentId: parent.id,
      });
    },
  );
}

// Returns the latest message-y event text per session.
//
// Naive `ORDER BY id DESC LIMIT N*8` was wrong: any session whose most-
// recent message.delta/complete sat outside the global top-N (i.e. an
// older but still-valid chat) would show "no messages yet". Instead we
// resolve each session's max(id) for the preview-eligible types, then
// fetch those exact rows. Cost: 2 small indexed queries.
async function loadPreviewsForSessions(
  db: Db,
  sessionIds: ReadonlyArray<string>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (sessionIds.length === 0) return out;
  const latestPerSession = await db
    .select({
      appSessionId: wsEvents.appSessionId,
      maxId: max(wsEvents.id),
    })
    .from(wsEvents)
    .where(
      and(
        inArray(wsEvents.appSessionId, [...sessionIds]),
        inArray(wsEvents.type, [...PREVIEW_EVENT_TYPES]),
      ),
    )
    .groupBy(wsEvents.appSessionId);
  const ids = latestPerSession
    .map((r) => r.maxId)
    .filter((v): v is number => typeof v === "number");
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      appSessionId: wsEvents.appSessionId,
      payloadJson: wsEvents.payloadJson,
    })
    .from(wsEvents)
    .where(inArray(wsEvents.id, ids));
  for (const r of rows) {
    const text = extractPreviewText(r.payloadJson);
    if (text) out.set(r.appSessionId, text);
  }
  return out;
}

function extractPreviewText(payloadJson: string): string | null {
  try {
    const obj = JSON.parse(payloadJson) as Record<string, unknown>;
    const candidate =
      typeof obj["text"] === "string"
        ? obj["text"]
        : typeof obj["delta"] === "string"
          ? obj["delta"]
          : null;
    if (!candidate) return null;
    const trimmed = candidate.trim().replace(/\s+/g, " ");
    if (!trimmed) return null;
    return trimmed.length <= PREVIEW_MAX_CHARS
      ? trimmed
      : trimmed.slice(0, PREVIEW_MAX_CHARS - 1) + "…";
  } catch {
    return null;
  }
}

// Best-effort filter: the contract isn't precise on the search payload shape,
// so we only filter known-array results. Untyped fields are passed through.
function filterSearchResultsByOwnership(
  upstream: unknown,
  ownedHermesIds: ReadonlySet<string>,
): unknown {
  if (!upstream || typeof upstream !== "object") return { results: [] };
  const obj = upstream as Record<string, unknown>;
  for (const key of ["results", "sessions", "matches"]) {
    const arr = obj[key];
    if (Array.isArray(arr)) {
      const filtered = arr.filter((item) => {
        if (!item || typeof item !== "object") return false;
        const sid = (item as Record<string, unknown>)["session_id"];
        return typeof sid === "string" && ownedHermesIds.has(sid);
      });
      return { ...obj, [key]: filtered };
    }
  }
  return obj;
}
