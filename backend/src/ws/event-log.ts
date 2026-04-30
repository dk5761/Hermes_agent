import { and, eq, gt, lt, desc } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { wsEvents } from "../db/schema.js";
import type { GatewayEventEnvelope } from "./envelope.js";
import type { AppLogger } from "../logger.js";

// Allowlist of upstream Hermes event types that are persisted for replay.
// Skip noisy events (voice.*, status.update) — they're live-only.
// Documented in HERMES_CONTRACT.md §"Events (server → client)".
export const PERSISTED_EVENT_TYPES: ReadonlySet<string> = new Set([
  // Gateway-emitted (synthesized by us, not from Hermes).
  // Hermes' /api/sessions/{id}/messages uses a different id namespace from
  // session.create, so we can't reconstruct user turns from upstream — we
  // log them ourselves on chat.send and rebuild history from this log.
  "gateway.user.message",
  // Hermes-emitted (from upstream tui_gateway dispatcher).
  "message.start",
  "message.delta",
  "message.complete",
  "thinking.delta",
  "reasoning.delta",
  "reasoning.available",
  "tool.start",
  "tool.generating",
  "tool.update",
  "tool.progress",
  "tool.complete",
  "subagent.start",
  "subagent.tool",
  "subagent.complete",
  "approval.request",
  "clarify.request",
  "sudo.request",
  "secret.request",
  "error",
  "session.info",
  "background.complete",
]);

export function isPersistedEventType(t: string): boolean {
  return PERSISTED_EVENT_TYPES.has(t);
}

export interface AppendEventInput {
  appSessionId: string;
  type: string;
  payload: unknown;
  createdAt?: number;
}

// Append an event row and return the resolved envelope (with monotonic id).
export async function appendEvent(
  db: Db,
  input: AppendEventInput,
): Promise<GatewayEventEnvelope> {
  const createdAt = input.createdAt ?? Math.floor(Date.now() / 1000);
  const inserted = await db
    .insert(wsEvents)
    .values({
      appSessionId: input.appSessionId,
      type: input.type,
      payloadJson: JSON.stringify(input.payload ?? null),
      createdAt,
    })
    .returning({ id: wsEvents.id });
  const idRow = inserted[0];
  if (!idRow) throw new Error("ws_events insert returned no row");
  return {
    id: idRow.id,
    sessionId: input.appSessionId,
    type: input.type,
    createdAt: new Date(createdAt * 1000).toISOString(),
    payload: input.payload,
  };
}

// Replay events strictly after `lastEventId` for the given app session.
// Cap to maxRows to avoid unbounded fetches; caller should send `sync.required`
// if the cap is hit and the gap is suspiciously large.
export async function eventsSince(
  db: Db,
  appSessionId: string,
  lastEventId: number,
  maxRows = 1000,
): Promise<GatewayEventEnvelope[]> {
  const rows = await db
    .select()
    .from(wsEvents)
    .where(and(eq(wsEvents.appSessionId, appSessionId), gt(wsEvents.id, lastEventId)))
    .orderBy(wsEvents.id)
    .limit(maxRows);
  return rows.map(rowToEnvelope);
}

// Returns true iff the gateway can fulfil a resume from `lastEventId` for the
// given session — i.e. that id exists, OR there are still rows older than the
// caller's pointer (we never deleted past it).
export async function canResume(
  db: Db,
  appSessionId: string,
  lastEventId: number,
): Promise<boolean> {
  if (lastEventId <= 0) return true;
  const olderOrEqual = await db
    .select({ id: wsEvents.id })
    .from(wsEvents)
    .where(and(eq(wsEvents.appSessionId, appSessionId), lt(wsEvents.id, lastEventId + 1)))
    .orderBy(desc(wsEvents.id))
    .limit(1);
  return olderOrEqual.length > 0;
}

function rowToEnvelope(row: typeof wsEvents.$inferSelect): GatewayEventEnvelope {
  let payload: unknown = null;
  try {
    payload = JSON.parse(row.payloadJson);
  } catch {
    // tolerate corrupt payload
    payload = row.payloadJson;
  }
  return {
    id: row.id,
    sessionId: row.appSessionId,
    type: row.type,
    createdAt: new Date(row.createdAt * 1000).toISOString(),
    payload,
  };
}

export interface SweepConfig {
  retentionHours: number;
  postRunGraceHours: number;
  // Always retain at least the most recent N events per session — keeps mid-run
  // resume safe even if the run took longer than retention.
  // Documented choice: simpler than cross-row run detection in SQL.
  keepLastPerSession: number;
}

export async function sweepOldEvents(
  db: Db,
  log: AppLogger,
  cfg: SweepConfig,
  now: number = Math.floor(Date.now() / 1000),
): Promise<{ deleted: number }> {
  const totalGraceSeconds = (cfg.retentionHours + cfg.postRunGraceHours) * 3600;
  const cutoff = now - totalGraceSeconds;

  // Per-session protected floor: id of the (keepLastPerSession)th most recent row.
  // If we delete only rows with id < that floor AND createdAt < cutoff, we
  // satisfy both the "always keep last N" and "respect retention" rules.
  const sessionFloors = await db
    .select({ appSessionId: wsEvents.appSessionId, id: wsEvents.id })
    .from(wsEvents);

  // Compute floors in JS (per-session top-K); SQLite drizzle lacks window funcs ergonomically.
  const perSession = new Map<string, number[]>();
  for (const row of sessionFloors) {
    const arr = perSession.get(row.appSessionId) ?? [];
    arr.push(row.id);
    perSession.set(row.appSessionId, arr);
  }
  const floors = new Map<string, number>();
  for (const [sid, ids] of perSession) {
    ids.sort((a, b) => b - a);
    const floor = ids[cfg.keepLastPerSession - 1];
    if (typeof floor === "number") floors.set(sid, floor);
  }

  // Two-pass delete: rows older than cutoff AND below the per-session floor.
  // For sessions with fewer than keepLastPerSession rows the floor is undefined —
  // those rows are fully protected.
  let totalDeleted = 0;
  for (const [sid, floor] of floors) {
    const result = await db
      .delete(wsEvents)
      .where(
        and(
          eq(wsEvents.appSessionId, sid),
          lt(wsEvents.id, floor),
          lt(wsEvents.createdAt, cutoff),
        ),
      )
      .returning({ id: wsEvents.id });
    totalDeleted += result.length;
  }
  if (totalDeleted > 0) {
    log.info({ deleted: totalDeleted, cutoff }, "ws_events sweep");
  }
  return { deleted: totalDeleted };
}

export interface SweeperHandle {
  stop: () => void;
}

export function startEventLogSweeper(
  db: Db,
  log: AppLogger,
  cfg: SweepConfig,
  intervalMs = 5 * 60 * 1000,
): SweeperHandle {
  const tick = (): void => {
    sweepOldEvents(db, log, cfg).catch((err: unknown) => {
      log.error({ err }, "ws_events sweep failed");
    });
  };
  const handle = setInterval(tick, intervalMs);
  handle.unref();
  // Run once at startup to clear stale rows before traffic builds up.
  tick();
  return {
    stop: () => clearInterval(handle),
  };
}
