// Server-side persisted queue for iOS tool calls.
//
// When the mobile app is unreachable (WS not connected and silent push failed
// to bring it back within the wake timeout), tool calls are persisted here.
// On the next WS reconnect for the user the router drains this queue and
// replays each call.
//
// MAX_QUEUE_AGE_S: calls older than this are dropped silently. Default 6h.
// Override via IOS_TOOL_QUEUE_MAX_AGE_S env variable.

import crypto from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { iosToolQueue } from "../db/schema.js";
import type { IosToolName } from "../types/ios-tools.js";

const DEFAULT_MAX_QUEUE_AGE_S = 21600; // 6 hours

function resolveMaxQueueAgeS(): number {
  const raw = process.env["IOS_TOOL_QUEUE_MAX_AGE_S"];
  if (raw !== undefined && raw.length > 0) {
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MAX_QUEUE_AGE_S;
}

export interface QueuedCall {
  id: string;
  userId: string;
  tool: IosToolName;
  args: Record<string, unknown>;
  queuedAt: number;
  attempts: number;
  lastAttemptAt: number | null;
}

export class IosToolQueue {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Persist a tool call for later replay. Returns the queue row id.
   */
  async enqueue(
    userId: string,
    tool: IosToolName,
    args: Record<string, unknown>,
  ): Promise<string> {
    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    await this.db.insert(iosToolQueue).values({
      id,
      userId,
      tool,
      argsJson: JSON.stringify(args),
      queuedAt: now,
      attempts: 0,
      lastAttemptAt: null,
    });
    return id;
  }

  /**
   * Return all queued calls for `userId` that are not older than
   * MAX_QUEUE_AGE_S, and atomically delete them from the queue.
   * Calls older than the age limit are also deleted (purged) but not returned.
   */
  async drainForUser(userId: string): Promise<QueuedCall[]> {
    const maxAgeS = resolveMaxQueueAgeS();
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeS;

    // Delete stale calls first so they don't come back to the caller.
    await this.db
      .delete(iosToolQueue)
      .where(and(eq(iosToolQueue.userId, userId), lt(iosToolQueue.queuedAt, cutoff)));

    // Fetch remaining rows for this user.
    const rows = await this.db
      .select()
      .from(iosToolQueue)
      .where(eq(iosToolQueue.userId, userId));

    if (rows.length === 0) return [];

    // Delete them — the router will replay each as a live call.
    await this.db.delete(iosToolQueue).where(eq(iosToolQueue.userId, userId));

    return rows.map(rowToQueuedCall);
  }

  /**
   * Purge all queue entries older than `ageSeconds`. Called by a periodic
   * sweeper in IosToolsRouter so stale entries don't accumulate forever for
   * users who never reconnect.
   */
  async purgeOlderThan(ageSeconds: number): Promise<number> {
    const cutoff = Math.floor(Date.now() / 1000) - ageSeconds;
    const deleted = await this.db
      .delete(iosToolQueue)
      .where(lt(iosToolQueue.queuedAt, cutoff))
      .returning({ id: iosToolQueue.id });
    return deleted.length;
  }
}

function rowToQueuedCall(row: typeof iosToolQueue.$inferSelect): QueuedCall {
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.argsJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      args = parsed as Record<string, unknown>;
    }
  } catch {
    // Leave args as empty object on corrupt JSON.
  }
  return {
    id: row.id,
    userId: row.userId,
    tool: row.tool as IosToolName,
    args,
    queuedAt: row.queuedAt,
    attempts: row.attempts,
    lastAttemptAt: row.lastAttemptAt ?? null,
  };
}
