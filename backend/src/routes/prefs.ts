// User notification preference routes.
//
// GET  /users/me/prefs  → 200 { notifyChatComplete: boolean }
// PUT  /users/me/prefs  → 200 { notifyChatComplete: boolean }
//   body: { notifyChatComplete?: boolean }
//
// GET: returns the current prefs for the authenticated user. If no row exists
//   yet (user has never written prefs), return the system defaults without
//   inserting a row — reads are always cheap and non-mutating.
//
// PUT: validates and upserts the row. Sets updatedAt to current unix epoch.

import { eq } from "drizzle-orm";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { userPrefs } from "../db/schema.js";

export interface PrefsRoutesDeps {
  db: Db;
  requireAuth: preHandlerHookHandler;
}

const putBody = z.object({
  notifyChatComplete: z.boolean().optional(),
});

interface PrefsView {
  notifyChatComplete: boolean;
}

// System defaults — used when the user has no row in user_prefs.
const DEFAULTS: PrefsView = {
  notifyChatComplete: true,
};

export async function registerPrefsRoutes(
  app: FastifyInstance,
  deps: PrefsRoutesDeps,
): Promise<void> {
  const { db, requireAuth } = deps;

  app.get("/users/me/prefs", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: "unauthenticated" });

    const rows = await db
      .select({ notifyChatComplete: userPrefs.notifyChatComplete })
      .from(userPrefs)
      .where(eq(userPrefs.userId, user.id))
      .limit(1);

    if (rows.length === 0) {
      return reply.send(DEFAULTS);
    }

    const row = rows[0]!;
    const view: PrefsView = {
      notifyChatComplete: row.notifyChatComplete === 1,
    };
    return reply.send(view);
  });

  app.put("/users/me/prefs", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: "unauthenticated" });

    const parsed = putBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    }

    // Fetch existing row so we know current values for any field not in body.
    const existing = await db
      .select({ notifyChatComplete: userPrefs.notifyChatComplete })
      .from(userPrefs)
      .where(eq(userPrefs.userId, user.id))
      .limit(1);

    const currentRow = existing[0];
    const currentNotify = currentRow !== undefined
      ? currentRow.notifyChatComplete === 1
      : DEFAULTS.notifyChatComplete;

    const newNotify =
      parsed.data.notifyChatComplete !== undefined
        ? parsed.data.notifyChatComplete
        : currentNotify;

    const now = Math.floor(Date.now() / 1000);

    await db
      .insert(userPrefs)
      .values({
        userId: user.id,
        notifyChatComplete: newNotify ? 1 : 0,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: userPrefs.userId,
        set: {
          notifyChatComplete: newNotify ? 1 : 0,
          updatedAt: now,
        },
      });

    const view: PrefsView = { notifyChatComplete: newNotify };
    return reply.send(view);
  });
}
