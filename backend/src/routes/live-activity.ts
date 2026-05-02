import { and, eq } from "drizzle-orm";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { appSessions, liveActivityTokens } from "../db/schema.js";

export interface LiveActivityRoutesDeps {
  db: Db;
  requireAuth: preHandlerHookHandler;
}

const registerBody = z.object({
  appSessionId: z.string().min(1),
  activityId: z.string().min(1).max(200),
  pushToken: z.string().min(1).max(400),
  kind: z.enum(["chat", "approval"]),
});

const idParams = z.object({ activityId: z.string().min(1).max(200) });

export async function registerLiveActivityRoutes(
  app: FastifyInstance,
  deps: LiveActivityRoutesDeps,
): Promise<void> {
  const { db, requireAuth } = deps;

  // Upsert by activityId so a refreshed push token (Apple rotates them on
  // device migrations / restarts) replaces the previous row in place.
  app.post(
    "/live-activity/tokens",
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = request.user;
      if (!user) return reply.code(401).send({ error: "unauthenticated" });
      const parsed = registerBody.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "invalid_body", details: parsed.error.flatten() });
      }
      // Validate session ownership before storing the token.
      const owned = await db
        .select({ id: appSessions.id })
        .from(appSessions)
        .where(
          and(
            eq(appSessions.id, parsed.data.appSessionId),
            eq(appSessions.userId, user.id),
          ),
        )
        .limit(1);
      if (!owned[0]) return reply.code(404).send({ error: "session_not_found" });

      const now = Math.floor(Date.now() / 1000);
      const existing = await db
        .select({ activityId: liveActivityTokens.activityId })
        .from(liveActivityTokens)
        .where(eq(liveActivityTokens.activityId, parsed.data.activityId))
        .limit(1);
      if (existing[0]) {
        await db
          .update(liveActivityTokens)
          .set({
            pushToken: parsed.data.pushToken,
            kind: parsed.data.kind,
            updatedAt: now,
          })
          .where(eq(liveActivityTokens.activityId, parsed.data.activityId));
      } else {
        await db.insert(liveActivityTokens).values({
          activityId: parsed.data.activityId,
          appSessionId: parsed.data.appSessionId,
          userId: user.id,
          pushToken: parsed.data.pushToken,
          kind: parsed.data.kind,
          createdAt: now,
          updatedAt: now,
        });
      }
      return reply.code(201).send({ ok: true });
    },
  );

  app.delete(
    "/live-activity/tokens/:activityId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = request.user;
      if (!user) return reply.code(401).send({ error: "unauthenticated" });
      const parsed = idParams.safeParse(request.params);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_param" });
      await db
        .delete(liveActivityTokens)
        .where(
          and(
            eq(liveActivityTokens.activityId, parsed.data.activityId),
            eq(liveActivityTokens.userId, user.id),
          ),
        );
      return reply.code(204).send();
    },
  );
}
