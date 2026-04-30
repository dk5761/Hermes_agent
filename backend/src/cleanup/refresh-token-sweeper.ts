// Refresh token sweeper. Removes:
//   - rows revoked more than `graceDays` ago (kept briefly to allow forensics)
//   - rows whose expires_at fell more than 1 day in the past

import { lt, or, and, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { refreshTokens } from "../db/schema.js";
import type { AppLogger } from "../logger.js";
import type { CleanupResult } from "./runner.js";

export interface RefreshTokenSweeperDeps {
  db: Db;
  logger: AppLogger;
}

export interface RefreshTokenSweeperConfig {
  graceDays: number;
}

export async function sweepRefreshTokens(
  deps: RefreshTokenSweeperDeps,
  cfg: RefreshTokenSweeperConfig,
  now: number = Math.floor(Date.now() / 1000),
): Promise<CleanupResult> {
  const log = deps.logger.child({ task: "refresh-tokens" });
  const startedAt = Date.now();
  const revokedCutoff = now - cfg.graceDays * 86400;
  const expiredCutoff = now - 86400;

  const result = await deps.db
    .delete(refreshTokens)
    .where(
      or(
        and(
          isNotNull(refreshTokens.revokedAt),
          lt(refreshTokens.revokedAt, revokedCutoff),
        ),
        lt(refreshTokens.expiresAt, expiredCutoff),
      ),
    )
    .returning({ id: refreshTokens.id });

  const durationMs = Date.now() - startedAt;
  const deleted = result.length;
  if (deleted > 0) {
    log.info({ deleted, durationMs }, "refresh token sweep");
  }
  return {
    task: "refresh-tokens",
    scanned: deleted,
    deleted,
    errors: 0,
    durationMs,
    lastRunAt: Math.floor(Date.now() / 1000),
  };
}
