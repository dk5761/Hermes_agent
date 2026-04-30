import crypto from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { refreshTokens } from "../db/schema.js";

export interface IssuedRefreshToken {
  token: string;
  id: string;
  expiresAt: number;
}

const REFRESH_TOKEN_BYTES = 48;

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function newId(): string {
  return crypto.randomUUID();
}

export async function issueRefreshToken(
  db: Db,
  userId: string,
  ttlDays: number,
  now: number = Math.floor(Date.now() / 1000),
): Promise<IssuedRefreshToken> {
  const token = crypto.randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");
  const id = newId();
  const expiresAt = now + ttlDays * 86400;
  await db.insert(refreshTokens).values({
    id,
    userId,
    tokenHash: hashToken(token),
    expiresAt,
    revokedAt: null,
    createdAt: now,
  });
  return { token, id, expiresAt };
}

// TODO: Phase >1 — implement refresh-token rotation. For MVP we do non-rotating refresh.
export async function validateRefreshToken(
  db: Db,
  token: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<{ userId: string; id: string } | null> {
  const tokenHash = hashToken(token);
  const rows = await db
    .select()
    .from(refreshTokens)
    .where(and(eq(refreshTokens.tokenHash, tokenHash), gt(refreshTokens.expiresAt, now), isNull(refreshTokens.revokedAt)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { userId: row.userId, id: row.id };
}

export async function revokeRefreshToken(
  db: Db,
  token: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const tokenHash = hashToken(token);
  const result = await db
    .update(refreshTokens)
    .set({ revokedAt: now })
    .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt)))
    .returning({ id: refreshTokens.id });
  return result.length > 0;
}

export async function revokeAllForUser(db: Db, userId: string, now: number = Math.floor(Date.now() / 1000)): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: now })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
}
