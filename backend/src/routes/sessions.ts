import crypto from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { appSessions, wsEvents } from "../db/schema.js";
import type { HermesHttpClient } from "../hermes/http-client.js";
import { HermesUpstreamError } from "../hermes/types.js";
import type { AppLogger } from "../logger.js";

const PREVIEW_EVENT_TYPES = ["message.complete", "message.delta"] as const;
const PREVIEW_MAX_CHARS = 120;

export interface SessionsRoutesDeps {
  db: Db;
  requireAuth: preHandlerHookHandler;
  hermesHttp: HermesHttpClient;
  logger: AppLogger;
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

export async function registerSessionsRoutes(
  app: FastifyInstance,
  deps: SessionsRoutesDeps,
): Promise<void> {
  const { db, requireAuth, hermesHttp, logger } = deps;

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
    await db.delete(appSessions).where(eq(appSessions.id, row.id));
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

  app.get(
    "/sessions/:id/messages",
    { preHandler: requireAuth },
    async (request, reply) => {
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
      if (!row.hermesSessionId) return reply.send({ messages: [] });

      try {
        const data = await hermesHttp.getSessionMessages(row.hermesSessionId);
        return reply.send(data);
      } catch (err) {
        if (err instanceof HermesUpstreamError && err.status === 404) {
          return reply.send({ messages: [] });
        }
        throw err;
      }
    },
  );
}

// Returns the latest message-y event text per session, scanning the most recent
// rows of ws_events. SQLite is fine for the small N we have on personal use.
async function loadPreviewsForSessions(
  db: Db,
  sessionIds: ReadonlyArray<string>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (sessionIds.length === 0) return out;
  const rows = await db
    .select({
      appSessionId: wsEvents.appSessionId,
      type: wsEvents.type,
      payloadJson: wsEvents.payloadJson,
    })
    .from(wsEvents)
    .where(
      and(
        inArray(wsEvents.appSessionId, [...sessionIds]),
        inArray(wsEvents.type, [...PREVIEW_EVENT_TYPES]),
      ),
    )
    .orderBy(desc(wsEvents.id))
    .limit(sessionIds.length * 8);
  for (const r of rows) {
    if (out.has(r.appSessionId)) continue;
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
