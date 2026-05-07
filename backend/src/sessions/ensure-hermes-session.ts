import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { appSessions } from "../db/schema.js";
import type { HermesWsPool } from "../hermes/ws-pool.js";
import type { AppLogger } from "../logger.js";

// In-flight deduplication: if two concurrent callers race past the DB
// SELECT (both see hermesSessionId = null), the second one waits on the
// same Promise rather than firing a second session.create RPC. The entry
// is removed once the Promise settles so subsequent calls go through the
// fast DB path.
const inFlight = new Map<string, Promise<string>>();

// Discriminated reason codes for EnsureHermesSessionError so callers can
// surface meaningful HTTP bodies without parsing message strings.
type EnsureHermesSessionReason =
  | "session_create_returned_non_object"
  | "session_create_missing_session_id"
  | "session_create_failed";

/**
 * Thrown by `ensureHermesSession` when the upstream `session.create` call
 * fails or returns an unexpected shape.
 */
export class EnsureHermesSessionError extends Error {
  constructor(public readonly reason: EnsureHermesSessionReason, cause?: unknown) {
    super(`ensure_hermes_session: ${reason}`);
    this.name = "EnsureHermesSessionError";
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export interface EnsureHermesSessionArgs {
  db: Db;
  wsPool: HermesWsPool;
  appSessionId: string;
  logger?: AppLogger;
}

/**
 * Return the existing `hermes_session_id` for an app session, or lazily
 * create one by calling Hermes' `session.create` RPC and persisting the
 * returned id.
 *
 * This is the shared implementation used by both the WS gateway (which also
 * updates its in-memory reverse map) and HTTP route handlers (branch,
 * reload-mcp) that need a Hermes session before a slash command can run.
 *
 * @param args.db - Drizzle database handle
 * @param args.wsPool - Shared Hermes WS pool; `getOrCreateShared()` is called
 *   to obtain the upstream client.
 * @param args.appSessionId - PK of the `app_sessions` row.
 * @param args.logger - Optional structured logger for debug/warn output.
 * @returns The (possibly freshly created) `hermes_session_id` string.
 * @throws {EnsureHermesSessionError} If `session.create` fails or returns an
 *   unexpected shape. Callers should surface this as HTTP 503.
 */
export async function ensureHermesSession({
  db,
  wsPool,
  appSessionId,
  logger,
}: EnsureHermesSessionArgs): Promise<string> {
  // Fast path: already mapped.
  const rows = await db
    .select({ hermesSessionId: appSessions.hermesSessionId })
    .from(appSessions)
    .where(eq(appSessions.id, appSessionId))
    .limit(1);
  const existing = rows[0]?.hermesSessionId;
  if (existing) return existing;

  // Dedup: if another concurrent caller is already creating a session for this
  // appSessionId, wait on its Promise rather than racing a second session.create.
  const pending = inFlight.get(appSessionId);
  if (pending) return pending;

  // Slow path: create a new Hermes session.
  const work = (async (): Promise<string> => {
    logger?.debug({ appSessionId }, "ensureHermesSession: calling session.create");

    let result: unknown;
    try {
      result = await wsPool.getOrCreateShared().request<unknown>("session.create", {});
    } catch (err) {
      logger?.warn({ err, appSessionId }, "ensureHermesSession: session.create threw");
      throw new EnsureHermesSessionError("session_create_failed", err);
    }

    if (!result || typeof result !== "object") {
      throw new EnsureHermesSessionError("session_create_returned_non_object");
    }

    const hsid = (result as Record<string, unknown>)["session_id"];
    if (typeof hsid !== "string" || !hsid) {
      throw new EnsureHermesSessionError("session_create_missing_session_id");
    }

    const now = Math.floor(Date.now() / 1000);
    await db
      .update(appSessions)
      .set({ hermesSessionId: hsid, updatedAt: now })
      .where(eq(appSessions.id, appSessionId));

    logger?.debug({ appSessionId, hermesSessionId: hsid }, "ensureHermesSession: persisted new session");

    return hsid;
  })();

  inFlight.set(appSessionId, work);
  try {
    return await work;
  } finally {
    inFlight.delete(appSessionId);
  }
}
