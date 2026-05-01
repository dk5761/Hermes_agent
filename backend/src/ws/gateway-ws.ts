import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import type { Db } from "../db/client.js";
import { appSessions } from "../db/schema.js";
import type { AppLogger } from "../logger.js";
import type { JwtConfig } from "../auth/jwt.js";
import { verifyWsAuth } from "../middleware/require-auth-ws.js";
import { controlMessage, envelopeJson, type GatewayEventEnvelope } from "./envelope.js";
import {
  appendEvent,
  canResume,
  eventsSince,
  isPersistedEventType,
} from "./event-log.js";
import { appendHistory, type HistoryKind } from "./chat-history.js";
import type { HermesWsPool } from "../hermes/ws-pool.js";
import type { HermesEventParams, JsonValue } from "../hermes/types.js";
import {
  AttachmentBridge,
  AttachmentUnauthorizedError,
  type AttachmentBridgeWarning,
} from "./attachment-bridge.js";
import type { ChatRunTimer } from "../observability/chat-run-timer.js";

export interface GatewayWsDeps {
  db: Db;
  jwt: JwtConfig;
  logger: AppLogger;
  wsPool: HermesWsPool;
  attachmentBridge: AttachmentBridge;
  // Phase 7: per-run timing recorder. Optional so tests can omit it.
  chatRunTimer?: ChatRunTimer;
}

// Reverse map hermes_session_id -> app_session_id, populated lazily as
// session.info events flow in or as routes resolve mappings. Hermes events
// arrive with `session_id` (hermes-side); we need the app-side id to route.
class ReverseSessionMap {
  private readonly db: Db;
  private readonly cache = new Map<string, string>();
  constructor(db: Db) {
    this.db = db;
  }
  async lookup(hermesSessionId: string): Promise<string | null> {
    const cached = this.cache.get(hermesSessionId);
    if (cached) return cached;
    const rows = await this.db
      .select({ id: appSessions.id })
      .from(appSessions)
      .where(eq(appSessions.hermesSessionId, hermesSessionId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    this.cache.set(hermesSessionId, row.id);
    return row.id;
  }
  set(hermesSessionId: string, appSessionId: string): void {
    this.cache.set(hermesSessionId, appSessionId);
  }
  invalidate(hermesSessionId: string): void {
    this.cache.delete(hermesSessionId);
  }
}

// Subscribers indexed by app_session_id. Each gateway WS client registers
// itself for exactly one app session; events fan out 1->N.
class SubscriberRegistry {
  private readonly subs = new Map<string, Set<(env: GatewayEventEnvelope) => void>>();
  add(appSessionId: string, fn: (env: GatewayEventEnvelope) => void): () => void {
    const set = this.subs.get(appSessionId) ?? new Set();
    set.add(fn);
    this.subs.set(appSessionId, set);
    return () => {
      const s = this.subs.get(appSessionId);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) this.subs.delete(appSessionId);
    };
  }
  emit(appSessionId: string, env: GatewayEventEnvelope): void {
    const s = this.subs.get(appSessionId);
    if (!s) return;
    for (const fn of s) {
      try {
        fn(env);
      } catch {
        // listener-level errors swallowed; the WS handler logs separately.
      }
    }
  }
}

const wsQuerySchema = z.object({
  token: z.string().optional(),
  app_session_id: z.string().min(1),
  lastEventId: z.coerce.number().int().nonnegative().optional(),
});

type ClientFrame =
  | { type: "resume"; lastEventId: number }
  | { type: "chat.send"; text: string; attachmentIds?: string[] | undefined }
  | { type: "chat.abort" }
  | { type: "approval.respond"; requestId: string; choice: string; all?: boolean | undefined }
  | { type: "clarify.respond"; requestId: string; text: string }
  | { type: "sudo.respond"; requestId: string; choice: string }
  | { type: "secret.respond"; requestId: string; value: string }
  | { type: "ping" };

const clientFrameSchema: z.ZodType<ClientFrame> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("resume"), lastEventId: z.number().int().nonnegative() }),
  z.object({
    type: z.literal("chat.send"),
    text: z.string().min(1),
    attachmentIds: z.array(z.string().min(1)).max(20).optional(),
  }),
  z.object({ type: z.literal("chat.abort") }),
  z.object({
    type: z.literal("approval.respond"),
    requestId: z.string(),
    choice: z.string(),
    all: z.boolean().optional(),
  }),
  z.object({ type: z.literal("clarify.respond"), requestId: z.string(), text: z.string() }),
  z.object({ type: z.literal("sudo.respond"), requestId: z.string(), choice: z.string() }),
  z.object({ type: z.literal("secret.respond"), requestId: z.string(), value: z.string() }),
  z.object({ type: z.literal("ping") }),
]);

export async function registerGatewayWsRoute(
  app: FastifyInstance,
  deps: GatewayWsDeps,
): Promise<void> {
  const reverse = new ReverseSessionMap(deps.db);
  const registry = new SubscriberRegistry();
  const log = deps.logger.child({ component: "gateway-ws" });

  // Single shared upstream listener — demux by session_id and forward to the
  // matching app_session subscribers. Persist allowlisted events along the way.
  const sharedClient = deps.wsPool.getOrCreateShared();
  sharedClient.onEvent((ev) => {
    void handleUpstreamEvent(ev, deps.db, reverse, registry, log, deps.chatRunTimer);
  });

  app.get(
    "/ws",
    { websocket: true },
    async (socket: WebSocket, request: FastifyRequest) => {
      const handler = new GatewayClientHandler({
        socket,
        request,
        deps,
        registry,
        reverse,
        log,
      });
      await handler.run();
    },
  );
}

interface GatewayClientHandlerArgs {
  socket: WebSocket;
  request: FastifyRequest;
  deps: GatewayWsDeps;
  registry: SubscriberRegistry;
  reverse: ReverseSessionMap;
  log: AppLogger;
}

class GatewayClientHandler {
  private readonly socket: WebSocket;
  private readonly request: FastifyRequest;
  private readonly deps: GatewayWsDeps;
  private readonly registry: SubscriberRegistry;
  private readonly reverse: ReverseSessionMap;
  private readonly log: AppLogger;
  private detachUpstream: (() => void) | null = null;
  private detachSubscribe: (() => void) | null = null;
  private appSessionId: string | null = null;
  private userId: string | null = null;

  constructor(args: GatewayClientHandlerArgs) {
    this.socket = args.socket;
    this.request = args.request;
    this.deps = args.deps;
    this.registry = args.registry;
    this.reverse = args.reverse;
    this.log = args.log;
  }

  async run(): Promise<void> {
    const user = await verifyWsAuth(this.request, {
      db: this.deps.db,
      jwt: this.deps.jwt,
    });
    if (!user) {
      this.closeWith(4401, "unauthenticated");
      return;
    }

    const parsed = wsQuerySchema.safeParse(this.request.query);
    if (!parsed.success) {
      this.closeWith(4400, "invalid_query");
      return;
    }
    const { app_session_id: appSessionId, lastEventId } = parsed.data;

    const sessionRows = await this.deps.db
      .select()
      .from(appSessions)
      .where(and(eq(appSessions.id, appSessionId), eq(appSessions.userId, user.id)))
      .limit(1);
    const session = sessionRows[0];
    if (!session) {
      this.closeWith(4403, "session_not_owned");
      return;
    }

    this.userId = user.id;
    this.appSessionId = appSessionId;

    // Acquire upstream WS slot for this app session (refcount-based).
    const acquired = this.deps.wsPool.acquire(appSessionId);
    this.detachUpstream = acquired.release;

    // Subscribe to demuxed events for this app session.
    this.detachSubscribe = this.registry.add(appSessionId, (env) => {
      this.sendJson(env);
    });

    // Wire socket events.
    this.socket.on("message", (data: Buffer) => {
      void this.onMessage(data);
    });
    this.socket.on("close", () => this.cleanup());
    this.socket.on("error", (err: unknown) => {
      this.log.warn({ err }, "gateway WS error");
      this.cleanup();
    });

    // gateway.ready before any catch-up traffic.
    this.sendControl("gateway.ready", { sessionId: appSessionId });

    // Optional inline resume from lastEventId on the upgrade URL.
    if (typeof lastEventId === "number") {
      await this.handleResume(lastEventId);
    }
  }

  private async onMessage(buf: Buffer): Promise<void> {
    let text: string;
    try {
      text = buf.toString("utf8");
    } catch {
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      this.sendControl("control.error", { error: "invalid_json" });
      return;
    }
    const parsed = clientFrameSchema.safeParse(json);
    if (!parsed.success) {
      this.sendControl("control.error", { error: "invalid_frame", details: parsed.error.flatten() });
      return;
    }
    const frame = parsed.data;
    const sessionId = this.appSessionId;
    if (!sessionId) return;

    switch (frame.type) {
      case "resume":
        await this.handleResume(frame.lastEventId);
        return;
      case "chat.send":
        await this.handleChatSend(frame.text, frame.attachmentIds ?? []);
        return;
      case "chat.abort":
        await this.handleChatAbort();
        return;
      case "approval.respond":
      case "clarify.respond":
      case "sudo.respond":
      case "secret.respond":
        await this.handlePassthroughResponse(frame);
        return;
      case "ping":
        this.sendControl("ack", { pong: true });
        return;
    }
  }

  private async handleResume(lastEventId: number): Promise<void> {
    const sid = this.appSessionId;
    if (!sid) return;
    const ok = await canResume(this.deps.db, sid, lastEventId);
    if (!ok) {
      this.sendControl("sync.required", {
        reason: "lastEventId not found in retained log",
      });
      return;
    }
    const missed = await eventsSince(this.deps.db, sid, lastEventId);
    for (const env of missed) this.sendJson(env);
  }

  private async handleChatSend(text: string, attachmentIds: readonly string[]): Promise<void> {
    const sid = this.appSessionId;
    const userId = this.userId;
    if (!sid || !userId) return;

    // Auto-title from the first user message when no manual override exists.
    // Hermes' /api/sessions/{id} uses a different id namespace from session.create,
    // so we can't fetch the title from there — derive it locally instead.
    await this.maybeAutoTitle(sid, text);

    let bridgeResult: Awaited<ReturnType<AttachmentBridge["build"]>> | null = null;
    if (attachmentIds.length > 0) {
      try {
        bridgeResult = await this.deps.attachmentBridge.build({
          userId,
          appSessionId: sid,
          attachmentIds,
        });
      } catch (err) {
        if (err instanceof AttachmentUnauthorizedError) {
          this.sendControl("control.error", {
            error: "attachment_unauthorized",
            attachmentId: err.attachmentId,
          });
          return;
        }
        this.log.error({ err }, "attachment bridge failed");
        this.sendControl("control.error", { error: "attachment_resolution_failed" });
        return;
      }
      this.surfaceAttachmentWarnings(bridgeResult.warnings);
    }

    const sharedClient = this.deps.wsPool.getOrCreateShared();
    let hermesSessionId = await this.getOrCreateHermesSession(sid);
    if (!hermesSessionId) {
      try {
        hermesSessionId = await this.createHermesSession(sid);
      } catch (err) {
        this.log.error({ err }, "session.create failed");
        this.sendControl("control.error", { error: "session_create_failed" });
        return;
      }
    }

    // Apply per-session model override (if any) before forwarding the prompt.
    // Hermes' tui_gateway accepts `config.set` with key=model, value="<model>
    // --provider <provider>" — it's an in-memory swap scoped to the session.
    // Failures here are non-fatal; we log and continue with the prior model
    // so the user still gets a response, just without the override applied.
    await this.maybeApplySessionModelOverride(sid, hermesSessionId, sharedClient);

    // image.attach must precede prompt.submit so Hermes binds the image to the
    // current turn (per HERMES_CONTRACT.md). Failures here are surfaced as
    // control.error and abort the turn rather than silently dropping images.
    if (bridgeResult) {
      for (const img of bridgeResult.imagePaths) {
        try {
          await sharedClient.request("image.attach", {
            session_id: hermesSessionId,
            path: img.localPath,
          });
        } catch (err) {
          this.log.error({ err, attachmentId: img.attachmentId }, "image.attach failed");
          this.sendControl("control.error", {
            error: "image_attach_failed",
            attachmentId: img.attachmentId,
          });
          return;
        }
      }
    }

    const finalText = buildFinalPromptText(text, bridgeResult?.promptPrefix ?? "");

    // Persist the user turn to both logs:
    //   - ws_events: short-lived replay log used for mid-stream reconnect
    //   - chat_history: permanent narrative log used for cold-load history
    try {
      const userPayload = {
        text,
        finalText,
        attachmentIds: attachmentIds.length > 0 ? [...attachmentIds] : undefined,
      };
      const env = await appendEvent(this.deps.db, {
        appSessionId: sid,
        type: "gateway.user.message",
        payload: userPayload,
      });
      this.sendJson(env);
      await appendHistory(this.deps.db, sid, "user.message", userPayload);
    } catch (err) {
      this.log.warn({ err }, "failed to persist user message");
    }

    try {
      await sharedClient.request("prompt.submit", {
        session_id: hermesSessionId,
        text: finalText,
      });
    } catch (err) {
      // Hermes' tui_gateway sessions live in-memory only — they vanish on
      // Hermes restart or after idle eviction, but our app_sessions row still
      // holds the stale 8-char hex id. Detect that case and re-create the
      // upstream session, then retry prompt.submit once.
      const reason = errorMessage(err);
      const sessionGone = /session not found|unknown session|no session/i.test(reason);
      if (sessionGone) {
        this.log.warn({ err, hermesSessionId }, "upstream session evicted, recreating and retrying");
        try {
          await this.clearHermesSessionMapping(sid);
          const fresh = await this.createHermesSession(sid);
          await sharedClient.request("prompt.submit", {
            session_id: fresh,
            text: finalText,
          });
          return;
        } catch (retryErr) {
          this.log.error({ err: retryErr }, "prompt.submit retry after recreate failed");
          this.sendControl("control.error", { error: "prompt_submit_failed" });
          return;
        }
      }
      this.log.error({ err }, "prompt.submit failed");
      this.sendControl("control.error", { error: "prompt_submit_failed" });
    }
  }

  private surfaceAttachmentWarnings(warnings: AttachmentBridgeWarning[]): void {
    for (const w of warnings) {
      this.sendControl("control.error", {
        error: w.code,
        attachmentId: w.attachmentId,
        message: w.message,
      });
    }
  }

  private async handleChatAbort(): Promise<void> {
    const sid = this.appSessionId;
    if (!sid) return;
    const hermesSessionId = await this.getOrCreateHermesSession(sid);
    if (!hermesSessionId) return;
    const sharedClient = this.deps.wsPool.getOrCreateShared();
    try {
      await sharedClient.request("session.interrupt", {
        session_id: hermesSessionId,
      });
      // Phase 7: flush the in-flight run timer so the aborted run appears in
      // the chat_run log even though Hermes won't emit message.complete.
      this.deps.chatRunTimer?.recordRunComplete(sid, "aborted");
    } catch (err) {
      this.log.warn({ err }, "session.interrupt failed");
    }
  }

  private async handlePassthroughResponse(
    frame:
      | { type: "approval.respond"; requestId: string; choice: string; all?: boolean | undefined }
      | { type: "clarify.respond"; requestId: string; text: string }
      | { type: "sudo.respond"; requestId: string; choice: string }
      | { type: "secret.respond"; requestId: string; value: string },
  ): Promise<void> {
    const sid = this.appSessionId;
    if (!sid) return;
    const hermesSessionId = await this.getOrCreateHermesSession(sid);
    if (!hermesSessionId) {
      this.sendControl("control.error", { error: "no_hermes_session" });
      return;
    }
    const sharedClient = this.deps.wsPool.getOrCreateShared();
    const params: Record<string, JsonValue> = {
      session_id: hermesSessionId,
      request_id: frame.requestId,
    };
    let method: string;
    switch (frame.type) {
      case "approval.respond":
        method = "approval.respond";
        params["choice"] = frame.choice;
        if (frame.all !== undefined) params["all"] = frame.all;
        break;
      case "clarify.respond":
        method = "clarify.respond";
        params["text"] = frame.text;
        break;
      case "sudo.respond":
        method = "sudo.respond";
        params["choice"] = frame.choice;
        break;
      case "secret.respond":
        method = "secret.respond";
        params["value"] = frame.value;
        break;
    }
    try {
      await sharedClient.request(method, params);
    } catch (err) {
      this.log.warn({ err, method }, "passthrough response failed");
    }
  }

  private async getOrCreateHermesSession(appSessionId: string): Promise<string | null> {
    const rows = await this.deps.db
      .select({ id: appSessions.hermesSessionId })
      .from(appSessions)
      .where(eq(appSessions.id, appSessionId))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  // Lazily create a Hermes session and persist the mapping. Resolves with the
  // hermes_session_id once `session.create` returns. The contract notes that
  // session.info follows asynchronously — but session.create itself returns
  // the session_id synchronously (per HERMES_CONTRACT.md §"Methods").
  private async createHermesSession(appSessionId: string): Promise<string> {
    const sharedClient = this.deps.wsPool.getOrCreateShared();
    const result = await sharedClient.request<unknown>("session.create", {});
    if (!result || typeof result !== "object") {
      throw new Error("session.create returned non-object");
    }
    const r = result as Record<string, unknown>;
    const hsid = r["session_id"];
    if (typeof hsid !== "string" || !hsid) {
      throw new Error("session.create did not include session_id");
    }
    const now = Math.floor(Date.now() / 1000);
    await this.deps.db
      .update(appSessions)
      .set({ hermesSessionId: hsid, updatedAt: now })
      .where(eq(appSessions.id, appSessionId));
    this.reverse.set(hsid, appSessionId);
    return hsid;
  }

  // Drop the stale hermes_session_id from the app_sessions row + reverse cache.
  // Used when upstream rejects a session id that no longer exists in tui_gateway
  // (e.g. after Hermes restart or idle eviction).
  private async clearHermesSessionMapping(appSessionId: string): Promise<void> {
    const rows = await this.deps.db
      .select({ hermesSessionId: appSessions.hermesSessionId })
      .from(appSessions)
      .where(eq(appSessions.id, appSessionId))
      .limit(1);
    const stale = rows[0]?.hermesSessionId;
    await this.deps.db
      .update(appSessions)
      .set({ hermesSessionId: null, updatedAt: Math.floor(Date.now() / 1000) })
      .where(eq(appSessions.id, appSessionId));
    if (stale) this.reverse.invalidate(stale);
  }

  private async maybeApplySessionModelOverride(
    appSessionId: string,
    hermesSessionId: string,
    sharedClient: import("../hermes/ws-client.js").HermesWsClient,
  ): Promise<void> {
    let row: { modelOverride: string | null; providerOverride: string | null } | undefined;
    try {
      const rows = await this.deps.db
        .select({
          modelOverride: appSessions.modelOverride,
          providerOverride: appSessions.providerOverride,
        })
        .from(appSessions)
        .where(eq(appSessions.id, appSessionId))
        .limit(1);
      row = rows[0];
    } catch (err) {
      this.log.warn({ err }, "model_override lookup failed");
      return;
    }
    if (!row?.modelOverride) return;

    // Hermes' parse_model_flags accepts "<model> --provider <provider>".
    const value = row.providerOverride
      ? `${row.modelOverride} --provider ${row.providerOverride}`
      : row.modelOverride;
    try {
      await sharedClient.request("config.set", {
        session_id: hermesSessionId,
        key: "model",
        value,
      });
    } catch (err) {
      this.log.warn({ err, hermesSessionId }, "config.set model override failed");
      // Surface a non-fatal warning to the client so the chat header can flag
      // that the override didn't apply this turn.
      this.sendControl("control.warning", {
        warning: "model_override_apply_failed",
      });
    }
  }

  private async maybeAutoTitle(appSessionId: string, userText: string): Promise<void> {
    const trimmed = userText.trim();
    if (!trimmed) return;
    try {
      const rows = await this.deps.db
        .select({
          titleOverride: appSessions.titleOverride,
        })
        .from(appSessions)
        .where(eq(appSessions.id, appSessionId))
        .limit(1);
      const row = rows[0];
      if (!row || row.titleOverride) return;
      const title = trimmed.length <= 60 ? trimmed : trimmed.slice(0, 57) + "…";
      const now = Math.floor(Date.now() / 1000);
      await this.deps.db
        .update(appSessions)
        .set({ titleOverride: title, updatedAt: now })
        .where(eq(appSessions.id, appSessionId));
    } catch (err) {
      this.log.warn({ err }, "auto-title failed; continuing");
    }
  }

  private sendJson(value: unknown): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    const text =
      typeof value === "string"
        ? value
        : "id" in (value as object)
          ? envelopeJson(value as GatewayEventEnvelope)
          : JSON.stringify(value);
    this.socket.send(text);
  }

  private sendControl(
    type:
      | "gateway.ready"
      | "sync.required"
      | "ack"
      | "control.error"
      | "control.warning",
    payload?: unknown,
  ): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(controlMessage(type, payload));
  }

  private closeWith(code: number, reason: string): void {
    try {
      this.socket.close(code, reason);
    } catch {
      // ignore
    }
  }

  private cleanup(): void {
    if (this.detachSubscribe) {
      this.detachSubscribe();
      this.detachSubscribe = null;
    }
    if (this.detachUpstream) {
      this.detachUpstream();
      this.detachUpstream = null;
    }
  }
}

function buildFinalPromptText(userText: string, promptPrefix: string): string {
  if (!promptPrefix) return userText;
  return `${promptPrefix}\n\n${userText}`;
}

async function handleUpstreamEvent(
  ev: HermesEventParams,
  db: Db,
  reverse: ReverseSessionMap,
  registry: SubscriberRegistry,
  log: AppLogger,
  chatRunTimer: ChatRunTimer | undefined,
): Promise<void> {
  const hsid = ev.session_id;
  if (!hsid) return;
  const appSessionId = await reverse.lookup(hsid);
  if (!appSessionId) {
    // Could be a session created from an external Hermes UI we don't track.
    log.debug({ hsid, type: ev.type }, "upstream event for unmapped session");
    return;
  }
  // Phase 7: record per-run timing transitions. Errors flush as "errored" so
  // we still get a chat_run log line for failed runs.
  if (chatRunTimer) {
    if (ev.type === "message.start") chatRunTimer.recordRunStart(appSessionId);
    else if (ev.type === "message.complete") chatRunTimer.recordRunComplete(appSessionId, "completed");
    else if (ev.type === "error") chatRunTimer.recordRunComplete(appSessionId, "errored");
    else chatRunTimer.recordEvent(appSessionId, ev.type);
  }
  if (!isPersistedEventType(ev.type)) {
    // Live-only fan-out (no envelope id). We still need a stable shape for the
    // client; use id=-1 to flag "not resumable".
    const liveEnv: GatewayEventEnvelope = {
      id: -1,
      sessionId: appSessionId,
      type: ev.type,
      createdAt: new Date().toISOString(),
      payload: ev.payload ?? null,
    };
    registry.emit(appSessionId, liveEnv);
    return;
  }
  try {
    const env = await appendEvent(db, {
      appSessionId,
      type: ev.type,
      payload: ev.payload ?? null,
    });
    registry.emit(appSessionId, env);
    await maybePersistHistory(db, appSessionId, ev.type, ev.payload, log);
  } catch (err) {
    log.error({ err, type: ev.type }, "failed to persist upstream event");
  }
}

// Map a Hermes upstream event to the canonical chat_history kind, if any.
// Streaming-only deltas (message.delta, tool.progress, etc.) are deliberately
// omitted — they're not part of the permanent narrative.
const HISTORY_KIND_BY_UPSTREAM: ReadonlyMap<string, HistoryKind> = new Map([
  ["message.complete", "assistant.message"],
  ["tool.complete", "tool.call"],
  // Subagent runs render as tool cards; payload carries token rollups, file
  // lists, output_tail in a different shape but the renderer handles raw detail.
  ["subagent.complete", "tool.call"],
  ["reasoning.available", "reasoning"],
  ["approval.request", "approval.request"],
  ["clarify.request", "clarify.request"],
  ["sudo.request", "sudo.request"],
  ["secret.request", "secret.request"],
  ["error", "error"],
]);

async function maybePersistHistory(
  db: Db,
  appSessionId: string,
  upstreamType: string,
  payload: unknown,
  log: AppLogger,
): Promise<void> {
  const kind = HISTORY_KIND_BY_UPSTREAM.get(upstreamType);
  if (!kind) return;
  try {
    await appendHistory(db, appSessionId, kind, payload);
  } catch (err) {
    log.warn({ err, kind, upstreamType }, "failed to persist chat history row");
  }
}

// Best-effort string extraction from arbitrary thrown values for log + match.
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(err);
}
