// Device push token registration routes.
//
// POST /devices/push-token   — idempotent register/transfer.
// DELETE /devices/push-token — unregister, scoped to current user.
// POST /devices/test-push    — fan out a "Test notification" to every push
//                              token owned by the current user. Used by the
//                              Settings screen to verify push delivery end
//                              to end (token registered, APNs reachable).
//
// Note: the push_tokens table currently has no `device_name` column. The
// `deviceName` field on the request is accepted (for future use) and ignored.
// TODO: add a `device_name` column when we want richer device labeling.

import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { pushTokens } from "../db/schema.js";
import { ExpoClient } from "../push/expo-client.js";

export interface DevicesRoutesDeps {
  db: Db;
  requireAuth: preHandlerHookHandler;
  expoClient?: ExpoClient;
}

const registerBody = z.object({
  expoToken: z.string().min(1),
  platform: z.enum(["ios", "android"]),
  // Accepted for forward-compat; not persisted (no DB column yet).
  deviceName: z.string().min(1).max(120).optional(),
});

const unregisterBody = z.object({
  expoToken: z.string().min(1),
});

export async function registerDevicesRoutes(
  app: FastifyInstance,
  deps: DevicesRoutesDeps,
): Promise<void> {
  const { db, requireAuth } = deps;

  app.post("/devices/push-token", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: "unauthenticated" });
    const parsed = registerBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    }
    const { expoToken, platform } = parsed.data;
    if (!ExpoClient.isValidToken(expoToken)) {
      return reply.code(400).send({ error: "invalid_expo_token" });
    }

    const now = Math.floor(Date.now() / 1000);
    const existing = await db
      .select()
      .from(pushTokens)
      .where(eq(pushTokens.expoToken, expoToken))
      .limit(1);
    const row = existing[0];

    if (row) {
      // Idempotent re-registration. Transfer ownership to the current user
      // if the token was previously bound to someone else (covers re-login
      // on a shared device — rare in single-user app, but harmless here).
      await db
        .update(pushTokens)
        .set({ userId: user.id, platform, lastSeenAt: now })
        .where(eq(pushTokens.id, row.id));
      return reply.code(201).send({ id: row.id });
    }

    const id = crypto.randomUUID();
    await db.insert(pushTokens).values({
      id,
      userId: user.id,
      expoToken,
      platform,
      createdAt: now,
      lastSeenAt: now,
    });
    return reply.code(201).send({ id });
  });

  app.post("/devices/test-push", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: "unauthenticated" });
    const expo = deps.expoClient;
    if (!expo) {
      return reply.code(503).send({ error: "push_disabled" });
    }
    const tokens = await db
      .select({ token: pushTokens.expoToken })
      .from(pushTokens)
      .where(eq(pushTokens.userId, user.id));
    if (tokens.length === 0) {
      return reply.code(404).send({ error: "no_devices" });
    }
    const payloads = tokens.map((t) => ({
      to: t.token,
      title: "Hermes",
      body: "Test notification — push delivery is working.",
      sound: "default" as const,
      data: { type: "test" as const },
    }));
    const result = await expo.sendMany(payloads);
    if (result.staleTokens.length > 0) {
      for (const stale of result.staleTokens) {
        await db.delete(pushTokens).where(eq(pushTokens.expoToken, stale));
      }
    }
    return reply.code(200).send({
      sent: result.okCount,
      errors: result.errorCount,
      stale: result.staleTokens.length,
      devices: tokens.length,
    });
  });

  app.delete("/devices/push-token", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: "unauthenticated" });
    const parsed = unregisterBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    }
    const result = await db
      .delete(pushTokens)
      .where(
        and(
          eq(pushTokens.expoToken, parsed.data.expoToken),
          eq(pushTokens.userId, user.id),
        ),
      )
      .returning({ id: pushTokens.id });
    if (result.length === 0) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.code(204).send();
  });
}
