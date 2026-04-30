// Push token sweeper. Removes Expo push tokens whose `last_seen_at` is older
// than `staleDays`. Stale entries are usually devices that uninstalled the
// app or rotated their token; sending to them returns DeviceNotRegistered
// from Expo (the cron-output watcher already removes those eagerly).

import { lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { pushTokens } from "../db/schema.js";
import type { AppLogger } from "../logger.js";
import type { CleanupResult } from "./runner.js";

export interface PushTokenSweeperDeps {
  db: Db;
  logger: AppLogger;
}

export interface PushTokenSweeperConfig {
  staleDays: number;
}

export async function sweepPushTokens(
  deps: PushTokenSweeperDeps,
  cfg: PushTokenSweeperConfig,
  now: number = Math.floor(Date.now() / 1000),
): Promise<CleanupResult> {
  const log = deps.logger.child({ task: "push-tokens" });
  const startedAt = Date.now();
  const cutoff = now - cfg.staleDays * 86400;

  const result = await deps.db
    .delete(pushTokens)
    .where(lt(pushTokens.lastSeenAt, cutoff))
    .returning({ id: pushTokens.id });

  const durationMs = Date.now() - startedAt;
  const deleted = result.length;
  if (deleted > 0) {
    log.info({ deleted, durationMs }, "push token sweep");
  }
  return {
    task: "push-tokens",
    scanned: deleted,
    deleted,
    errors: 0,
    durationMs,
    lastRunAt: Math.floor(Date.now() / 1000),
  };
}
