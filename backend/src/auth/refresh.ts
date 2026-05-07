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

// Atomically validate + revoke the old refresh token and issue a new one for
// the same user. This is the "rotation" leg of refresh-token rotation: the
// caller hands in their current refresh token, we hand back a fresh access
// token *and* a fresh refresh token whose 30-day window restarts now. Old
// token is invalidated by row-revoke so a stolen-token replay attack is
// limited to the window before the legitimate client next refreshes.
//
// Returns null when the input token is invalid/expired/already revoked. The
// transaction guarantees we never end up in a half-rotated state where the
// old token is revoked but no new one was issued.
export async function rotateRefreshToken(
  db: Db,
  token: string,
  ttlDays: number,
  now: number = Math.floor(Date.now() / 1000),
): Promise<{ userId: string; refresh: IssuedRefreshToken } | null> {
  const tokenHash = hashToken(token);
  return db.transaction((tx) => {
    const rows = tx
      .select()
      .from(refreshTokens)
      .where(and(eq(refreshTokens.tokenHash, tokenHash), gt(refreshTokens.expiresAt, now), isNull(refreshTokens.revokedAt)))
      .limit(1)
      .all();
    const row = rows[0];
    if (!row) return null;

    const revoked = tx
      .update(refreshTokens)
      .set({ revokedAt: now })
      .where(and(eq(refreshTokens.id, row.id), isNull(refreshTokens.revokedAt)))
      .returning({ id: refreshTokens.id })
      .all();
    // Lost-the-race: another concurrent refresh already revoked this row. Bail
    // before issuing a new token so we don't double-rotate.
    if (revoked.length === 0) return null;

    const newToken = crypto.randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");
    const newId_ = newId();
    const expiresAt = now + ttlDays * 86400;
    tx.insert(refreshTokens)
      .values({
        id: newId_,
        userId: row.userId,
        tokenHash: hashToken(newToken),
        expiresAt,
        revokedAt: null,
        createdAt: now,
      })
      .run();

    return {
      userId: row.userId,
      refresh: { token: newToken, id: newId_, expiresAt },
    };
  });
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
