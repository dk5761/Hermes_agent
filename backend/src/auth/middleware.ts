import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import { verifyAccessToken, type JwtConfig } from "./jwt.js";

export interface RequireAuthDeps {
  db: Db;
  jwt: JwtConfig;
}

export function makeRequireAuth(deps: RequireAuthDeps): preHandlerHookHandler {
  return async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = request.headers["authorization"];
    if (!header || typeof header !== "string" || !header.startsWith("Bearer ")) {
      await reply.code(401).send({ error: "missing_bearer" });
      return;
    }
    const token = header.slice("Bearer ".length).trim();
    if (!token) {
      await reply.code(401).send({ error: "missing_bearer" });
      return;
    }

    let claims;
    try {
      claims = verifyAccessToken(token, deps.jwt);
    } catch {
      await reply.code(401).send({ error: "invalid_token" });
      return;
    }

    const rows = await deps.db.select().from(users).where(eq(users.id, claims.sub)).limit(1);
    const user = rows[0];
    if (!user) {
      await reply.code(401).send({ error: "user_not_found" });
      return;
    }

    request.user = { id: user.id, username: user.username };
  };
}
