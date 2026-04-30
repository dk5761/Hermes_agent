// Cron notify preference routes.
//
// GET  /cron/notify-prefs                    — list all prefs for current user.
// PUT  /cron/jobs/:hermesJobId/notify-prefs  — upsert one pref row.

import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { cronPrefs } from "../db/schema.js";

export interface CronPrefsRoutesDeps {
  db: Db;
  requireAuth: preHandlerHookHandler;
}

const idParams = z.object({ hermesJobId: z.string().min(1) });
const putBody = z.object({ notifyOnComplete: z.boolean() });

interface PrefView {
  jobId: string;
  notifyOnComplete: boolean;
  lastSeenOutputId: string | null;
  updatedAt: number;
}

export async function registerCronPrefsRoutes(
  app: FastifyInstance,
  deps: CronPrefsRoutesDeps,
): Promise<void> {
  const { db, requireAuth } = deps;

  app.get("/cron/notify-prefs", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: "unauthenticated" });
    const rows = await db
      .select({
        jobId: cronPrefs.hermesJobId,
        notifyOnComplete: cronPrefs.notifyOnComplete,
        lastSeenOutputId: cronPrefs.lastSeenOutputId,
        updatedAt: cronPrefs.updatedAt,
      })
      .from(cronPrefs)
      .where(eq(cronPrefs.userId, user.id));
    const prefs: PrefView[] = rows.map((r) => ({
      jobId: r.jobId,
      notifyOnComplete: r.notifyOnComplete === 1,
      lastSeenOutputId: r.lastSeenOutputId,
      updatedAt: r.updatedAt,
    }));
    return reply.send({ prefs });
  });

  app.put(
    "/cron/jobs/:hermesJobId/notify-prefs",
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = request.user;
      if (!user) return reply.code(401).send({ error: "unauthenticated" });
      const params = idParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "invalid_params" });
      const body = putBody.safeParse(request.body ?? {});
      if (!body.success) {
        return reply.code(400).send({ error: "invalid_body", details: body.error.flatten() });
      }

      const now = Math.floor(Date.now() / 1000);
      const flag = body.data.notifyOnComplete ? 1 : 0;

      const existing = await db
        .select()
        .from(cronPrefs)
        .where(
          and(
            eq(cronPrefs.userId, user.id),
            eq(cronPrefs.hermesJobId, params.data.hermesJobId),
          ),
        )
        .limit(1);
      const row = existing[0];

      let view: PrefView;
      if (row) {
        await db
          .update(cronPrefs)
          .set({ notifyOnComplete: flag, updatedAt: now })
          .where(eq(cronPrefs.id, row.id));
        view = {
          jobId: row.hermesJobId,
          notifyOnComplete: body.data.notifyOnComplete,
          lastSeenOutputId: row.lastSeenOutputId,
          updatedAt: now,
        };
      } else {
        const id = crypto.randomUUID();
        await db.insert(cronPrefs).values({
          id,
          userId: user.id,
          hermesJobId: params.data.hermesJobId,
          notifyOnComplete: flag,
          lastSeenOutputId: null,
          updatedAt: now,
        });
        view = {
          jobId: params.data.hermesJobId,
          notifyOnComplete: body.data.notifyOnComplete,
          lastSeenOutputId: null,
          updatedAt: now,
        };
      }
      return reply.send(view);
    },
  );
}
