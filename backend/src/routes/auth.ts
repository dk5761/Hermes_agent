import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import { verifyPassword } from "../auth/password.js";
import { signAccessToken, type JwtConfig } from "../auth/jwt.js";
import { issueRefreshToken, revokeRefreshToken, rotateRefreshToken } from "../auth/refresh.js";

export interface AuthRoutesDeps {
  db: Db;
  jwt: JwtConfig;
  refreshTtlDays: number;
  // Phase 7: tighter per-route rate limit for /auth/login (brute-force defense).
  // Using IP-based keys here since the request is not yet authenticated.
  loginRateLimit: {
    max: number;
    timeWindowMs: number;
  };
}

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

const logoutSchema = z.object({
  refreshToken: z.string().min(1),
});

export async function registerAuthRoutes(app: FastifyInstance, deps: AuthRoutesDeps): Promise<void> {
  // Login is the only auth route with stricter limits; refresh/logout already
  // require a valid token so brute-force pressure there is much lower.
  // Per-route override via `config.rateLimit` is the canonical fastify-rate-limit
  // pattern — it supersedes the global limit for this endpoint.
  app.post(
    "/auth/login",
    {
      config: {
        rateLimit: {
          max: deps.loginRateLimit.max,
          timeWindow: deps.loginRateLimit.timeWindowMs,
          keyGenerator: (req) => req.ip,
        },
      },
    },
    async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    }
    const { username, password } = parsed.data;
    const rows = await deps.db.select().from(users).where(eq(users.username, username)).limit(1);
    const user = rows[0];
    if (!user) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    const ok = await verifyPassword(user.passwordHash, password);
    if (!ok) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    const accessToken = signAccessToken({ sub: user.id, username: user.username }, deps.jwt);
    const refresh = await issueRefreshToken(deps.db, user.id, deps.refreshTtlDays);
    return reply.send({
      accessToken,
      refreshToken: refresh.token,
      refreshTokenExpiresAt: refresh.expiresAt,
      user: { id: user.id, username: user.username },
    });
  });

  app.post("/auth/refresh", async (request, reply) => {
    const parsed = refreshSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    // Rotation: every successful refresh revokes the old token and issues a
    // new one. Active users effectively never lose their session — the 30-day
    // window restarts on each refresh. A null result means the token was
    // invalid / expired / already revoked (concurrent-rotation race).
    const rotated = await rotateRefreshToken(
      deps.db,
      parsed.data.refreshToken,
      deps.refreshTtlDays,
    );
    if (!rotated) {
      return reply.code(401).send({ error: "invalid_refresh" });
    }
    const rows = await deps.db.select().from(users).where(eq(users.id, rotated.userId)).limit(1);
    const user = rows[0];
    if (!user) {
      return reply.code(401).send({ error: "user_not_found" });
    }
    const accessToken = signAccessToken({ sub: user.id, username: user.username }, deps.jwt);
    return reply.send({
      accessToken,
      refreshToken: rotated.refresh.token,
      refreshTokenExpiresAt: rotated.refresh.expiresAt,
    });
  });

  app.post("/auth/logout", async (request, reply) => {
    const parsed = logoutSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const revoked = await revokeRefreshToken(deps.db, parsed.data.refreshToken);
    return reply.send({ revoked });
  });
}
