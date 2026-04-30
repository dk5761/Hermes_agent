import type { FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import { verifyAccessToken, type JwtConfig } from "../auth/jwt.js";
import type { AuthedUser } from "../types/user.js";

export interface VerifyWsAuthDeps {
  db: Db;
  jwt: JwtConfig;
}

// Extract a JWT from upgrade requests. Per Phase 2 contract we accept the
// token via `?token=` (most reliable across native/RN clients which can't set
// custom headers on WS upgrade) OR via `Authorization: Bearer ...`.
export function extractJwtFromUpgrade(request: FastifyRequest): string | null {
  const q = request.query;
  if (q && typeof q === "object") {
    const t = (q as Record<string, unknown>)["token"];
    if (typeof t === "string" && t.length > 0) return t;
  }
  const auth = request.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const tok = auth.slice("Bearer ".length).trim();
    if (tok) return tok;
  }
  return null;
}

export async function verifyWsAuth(
  request: FastifyRequest,
  deps: VerifyWsAuthDeps,
): Promise<AuthedUser | null> {
  const token = extractJwtFromUpgrade(request);
  if (!token) return null;
  let claims;
  try {
    claims = verifyAccessToken(token, deps.jwt);
  } catch {
    return null;
  }
  const rows = await deps.db.select().from(users).where(eq(users.id, claims.sub)).limit(1);
  const user = rows[0];
  if (!user) return null;
  return { id: user.id, username: user.username };
}
