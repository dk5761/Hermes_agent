import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { refreshTokens, users } from "../db/schema.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { revokeAllForUser } from "../auth/refresh.js";
import type { AppLogger } from "../logger.js";

export interface AccountRoutesDeps {
  db: Db;
  requireAuth: preHandlerHookHandler;
  logger: AppLogger;
}

const MIN_PASSWORD_LEN = 12;

const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(512),
  newPassword: z.string().min(1).max(512),
});

const sessionIdParam = z.object({ id: z.string().min(1).max(80) });

export async function registerAccountRoutes(
  app: FastifyInstance,
  deps: AccountRoutesDeps,
): Promise<void> {
  const { db, requireAuth, logger } = deps;

  // -------------------------------------------------------------------------
  // POST /auth/change-password
  // -------------------------------------------------------------------------
  app.post(
    "/auth/change-password",
    { preHandler: requireAuth },
    async (request, reply) => {
      const u = request.user;
      if (!u) return reply.code(401).send({ error: "unauthenticated" });
      const parsed = changePasswordBody.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
      }
      if (parsed.data.newPassword.length < MIN_PASSWORD_LEN) {
        return reply.code(400).send({ error: "new_password_too_weak" });
      }

      const rows = await db.select().from(users).where(eq(users.id, u.id)).limit(1);
      const user = rows[0];
      if (!user) return reply.code(401).send({ error: "user_not_found" });

      const ok = await verifyPassword(user.passwordHash, parsed.data.currentPassword);
      if (!ok) {
        return reply.code(401).send({ error: "current_password_incorrect" });
      }

      const newHash = await hashPassword(parsed.data.newPassword);
      try {
        await db
          .update(users)
          .set({ passwordHash: newHash })
          .where(eq(users.id, u.id));
      } catch (err) {
        logger.error({ err, userId: u.id }, "failed to update password");
        return reply.code(500).send({ error: "internal_error" });
      }

      // Revoke all refresh tokens — force re-login on every device. The
      // current access token (JWT) remains valid until expiry; that's fine
      // since access TTL is short (~15m).
      try {
        await revokeAllForUser(db, u.id);
      } catch (err) {
        logger.warn({ err, userId: u.id }, "failed to revoke refresh tokens after password change");
      }

      return reply.send({ ok: true });
    },
  );

  // -------------------------------------------------------------------------
  // GET /auth/sessions — list this user's refresh-token rows.
  // -------------------------------------------------------------------------
  app.get(
    "/auth/sessions",
    { preHandler: requireAuth },
    async (request, reply) => {
      const u = request.user;
      if (!u) return reply.code(401).send({ error: "unauthenticated" });
      const rows = await db
        .select({
          id: refreshTokens.id,
          createdAt: refreshTokens.createdAt,
          expiresAt: refreshTokens.expiresAt,
          revokedAt: refreshTokens.revokedAt,
        })
        .from(refreshTokens)
        .where(eq(refreshTokens.userId, u.id));

      // Sort: most-recent first.
      rows.sort((a, b) => b.createdAt - a.createdAt);

      // Mark "current" = the most-recently-created non-revoked row. We don't
      // know which token the caller authenticated with (access tokens carry
      // only sub+username, not refresh-token id), so this is a best-effort
      // heuristic. Frontend uses it to label "this device" in the UI.
      let currentMarked = false;
      const out = rows.map((r) => {
        const isCurrent = !currentMarked && r.revokedAt === null;
        if (isCurrent) currentMarked = true;
        return {
          id: r.id,
          createdAt: r.createdAt,
          expiresAt: r.expiresAt,
          revokedAt: r.revokedAt,
          current: isCurrent,
        };
      });

      return reply.send({ sessions: out });
    },
  );

  // -------------------------------------------------------------------------
  // POST /auth/sessions/:id/revoke — revoke one row owned by this user.
  // -------------------------------------------------------------------------
  app.post(
    "/auth/sessions/:id/revoke",
    { preHandler: requireAuth },
    async (request, reply) => {
      const u = request.user;
      if (!u) return reply.code(401).send({ error: "unauthenticated" });
      const parsed = sessionIdParam.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_param" });
      }
      const now = Math.floor(Date.now() / 1000);
      const result = await db
        .update(refreshTokens)
        .set({ revokedAt: now })
        .where(
          and(
            eq(refreshTokens.id, parsed.data.id),
            eq(refreshTokens.userId, u.id),
            isNull(refreshTokens.revokedAt),
          ),
        )
        .returning({ id: refreshTokens.id });
      if (result.length === 0) {
        // Either not found, not owned by this user, or already revoked. Per
        // contract we still return 204 to avoid leaking which case it was.
        return reply.code(204).send();
      }
      return reply.code(204).send();
    },
  );
}
