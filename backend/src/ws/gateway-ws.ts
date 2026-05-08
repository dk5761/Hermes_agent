import { and, desc, eq, gte, isNotNull } from "drizzle-orm";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import type { Db } from "../db/client.js";
import { appSessions, chatHistory, wsEvents } from "../db/schema.js";
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
import {
  extractTtsMedia,
  extractMediaFromMessageText,
  translateHermesPath,
  relocateTtsBlob,
} from "./tts-bridge.js";
import { deriveTitleFromTurn } from "../util/auto-title.js";
import type { HermesWsPool } from "../hermes/ws-pool.js";
import type { HermesEventParams, JsonValue } from "../hermes/types.js";
import { ensureHermesSession } from "../sessions/ensure-hermes-session.js";
import {
  AttachmentBridge,
  AttachmentUnauthorizedError,
  type AttachmentBridgeWarning,
} from "./attachment-bridge.js";
import type { ChatRunTimer } from "../observability/chat-run-timer.js";
import type { LiveActivityPusher } from "../push/apns-live-activity.js";
import type { ChatCompleteNotifier } from "../push/chat-complete.js";
import { liveActivityTokens } from "../db/schema.js";
import type { IosToolsRouter } from "./ios-tools-router.js";
import { type IosToolResultFrame } from "../types/ios-tools.js";

export interface GatewayWsDeps {
  db: Db;
  jwt: JwtConfig;
  logger: AppLogger;
  wsPool: HermesWsPool;
  attachmentBridge: AttachmentBridge;
  /** Absolute path to the blob store root (STORAGE_LOCAL_ROOT). Used by the TTS bridge. */
  blobRoot: string;
  // Phase 7: per-run timing recorder. Optional so tests can omit it.
  chatRunTimer?: ChatRunTimer;
  // ActivityKit push provider — wired by server.ts.
  liveActivityPusher?: LiveActivityPusher;
  // Chat-complete Expo push notifier. Optional so tests can omit it.
  chatCompleteNotifier?: ChatCompleteNotifier;
  // Phase 4 (iOS native tools): request/response correlator. Optional so
  // existing tests and deployments without the feature continue to work.
  iosToolsRouter?: IosToolsRouter;
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
  | {
      type: "chat.send";
      text: string;
      attachmentIds?: string[] | undefined;
      // When true, truncate the last turn (latest user.message + every row
      // after it) from chat_history and ws_events, call session.undo on
      // Hermes, then proceed with a normal prompt.submit. UX matches
      // ChatGPT/Claude's "Regenerate" — old assistant response is replaced.
      regenerate?: boolean | undefined;
    }
  | { type: "chat.abort" }
  | { type: "approval.respond"; requestId: string; choice: string; all?: boolean | undefined }
  | { type: "clarify.respond"; requestId: string; text: string }
  | { type: "sudo.respond"; requestId: string; choice: string }
  | { type: "secret.respond"; requestId: string; value: string }
  | { type: "ping" }
  // Phase 4: iOS native tools — result frames sent mobile → gateway.
  | IosToolResultFrame;

const iosToolResultFrameSchema = z.object({
  type: z.literal("ios_tool_result"),
  call_id: z.string().min(1),
  ok: z.boolean(),
  result: z.record(z.unknown()).optional(),
  error: z
    .object({
      code: z.string().min(1),
      message: z.string(),
    })
    .optional(),
});

const clientFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("resume"), lastEventId: z.number().int().nonnegative() }),
  z.object({
    type: z.literal("chat.send"),
    text: z.string().min(1),
    attachmentIds: z.array(z.string().min(1)).max(20).optional(),
    regenerate: z.boolean().optional(),
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
  iosToolResultFrameSchema,
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
    void handleUpstreamEvent(
      ev,
      deps.db,
      reverse,
      registry,
      log,
      deps.blobRoot,
      deps.chatRunTimer,
      deps.liveActivityPusher,
      deps.chatCompleteNotifier,
    );
  });

  // Whenever the upstream WS connects (initial boot, reconnect after Hermes
  // restart, or after our gateway restart), every existing hermes_session_id
  // in our DB is stale. Hermes' tui_gateway pins a session's *event transport*
  // to the WS that created it (tui_gateway/ws.py:165-169 → on disconnect it
  // reassigns the session's transport to _stdio_transport, so subsequent
  // events go to Hermes' container stdout instead of any WS). The new WS we
  // just opened has no way to "rebind" — the only fix is to recreate the
  // session via session.create on the next chat.send. We force that by
  // clearing the cached upstream id; the recreate path in handleChatSend
  // already handles the case where hermesSessionId is null.
  sharedClient.onConnection((state) => {
    if (state !== "open") return;
    void invalidateAllHermesSessions(deps.db, reverse, log);
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
  private detachIosTools: (() => void) | null = null;
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

    // Register with the iOS tools router so tool call frames can be forwarded
    // to this WS and results correlated back to pending calls.
    if (this.deps.iosToolsRouter) {
      this.detachIosTools = this.deps.iosToolsRouter.registerWs(user.id, this.socket);
    }

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

    this.log.info({ frameType: frame.type, sessionId }, "ws frame received");

    switch (frame.type) {
      case "resume":
        await this.handleResume(frame.lastEventId);
        return;
      case "chat.send":
        await this.handleChatSend(
          frame.text,
          frame.attachmentIds ?? [],
          !!frame.regenerate,
        );
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
      case "ios_tool_result":
        if (this.deps.iosToolsRouter) {
          this.deps.iosToolsRouter.onResult(frame);
        }
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

  private async handleChatSend(
    text: string,
    attachmentIds: readonly string[],
    regenerate: boolean,
  ): Promise<void> {
    const sid = this.appSessionId;
    const userId = this.userId;
    if (!sid || !userId) return;

    if (regenerate) {
      // Drop the last turn so the new submission replaces it. Order matters:
      // truncate our local logs first, then ask Hermes to undo so its
      // in-memory history matches what the agent will see on the next
      // prompt.submit. Failures here are non-fatal — worst case the new
      // turn appends after the old one (still functional, just messy).
      await this.truncateLastTurn(sid);
    }

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
      // Hermes restart or after idle eviction. Two failure modes we can
      // recover from:
      //   1. session_gone: stale id; recreate then retry.
      //   2. session_busy (Hermes code 4009): a prior run() crashed before
      //      finally{} reset `running=False`. Send session.interrupt to
      //      force-clear, brief sleep, then retry on the same session id.
      const reason = errorMessage(err);
      this.log.warn({ err, hermesSessionId, reason }, "prompt.submit failed");
      const sessionGone =
        /session/i.test(reason) &&
        /not found|unknown|invalid|expired|missing|no such|gone|evicted/i.test(reason);
      const isInvalidParams = /-32602|invalid params/i.test(reason);
      const sessionBusy = /4009|session busy|busy/i.test(reason);

      if (sessionBusy && !sessionGone && !isInvalidParams) {
        this.log.warn({ hermesSessionId }, "upstream session busy, interrupting then retrying");
        try {
          await sharedClient.request("session.interrupt", { session_id: hermesSessionId });
          // Give Hermes' run-thread a moment to hit its finally{} and clear
          // the running flag.
          await new Promise((r) => setTimeout(r, 300));
          await sharedClient.request("prompt.submit", {
            session_id: hermesSessionId,
            text: finalText,
          });
          return;
        } catch (retryErr) {
          this.log.error({ err: retryErr }, "prompt.submit retry after interrupt failed");
          // Fall through to recreate path below — interrupt didn't help.
        }
      }

      if (sessionGone || isInvalidParams || sessionBusy) {
        this.log.warn({ hermesSessionId }, "upstream session unrecoverable, recreating");
        try {
          await this.clearHermesSessionMapping(sid);
          const fresh = await this.createHermesSession(sid);
          await this.maybeApplySessionModelOverride(sid, fresh, sharedClient);
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
  //
  // Delegates DB + RPC work to `ensureHermesSession` and then updates the
  // in-memory reverse map (WS-handler-only concern not needed by route callers).
  private async createHermesSession(appSessionId: string): Promise<string> {
    const hsid = await ensureHermesSession({
      db: this.deps.db,
      wsPool: this.deps.wsPool,
      appSessionId,
      logger: this.log,
    });
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

  private async truncateLastTurn(appSessionId: string): Promise<void> {
    // chat_history: drop the last user.message row + everything after it.
    try {
      const rows = await this.deps.db
        .select({ id: chatHistory.id })
        .from(chatHistory)
        .where(
          and(
            eq(chatHistory.appSessionId, appSessionId),
            eq(chatHistory.kind, "user.message"),
          ),
        )
        .orderBy(desc(chatHistory.id))
        .limit(1);
      const fromId = rows[0]?.id;
      if (typeof fromId === "number") {
        await this.deps.db
          .delete(chatHistory)
          .where(
            and(
              eq(chatHistory.appSessionId, appSessionId),
              gte(chatHistory.id, fromId),
            ),
          );
      }
    } catch (err) {
      this.log.warn({ err }, "regenerate: chat_history truncation failed");
    }

    // ws_events: drop the last gateway.user.message envelope + everything
    // after it. Replay window may shrink for other devices listening on
    // this session — they'll see sync.required and cold-load fresh.
    try {
      const rows = await this.deps.db
        .select({ id: wsEvents.id })
        .from(wsEvents)
        .where(
          and(
            eq(wsEvents.appSessionId, appSessionId),
            eq(wsEvents.type, "gateway.user.message"),
          ),
        )
        .orderBy(desc(wsEvents.id))
        .limit(1);
      const fromId = rows[0]?.id;
      if (typeof fromId === "number") {
        await this.deps.db
          .delete(wsEvents)
          .where(
            and(
              eq(wsEvents.appSessionId, appSessionId),
              gte(wsEvents.id, fromId),
            ),
          );
      }
    } catch (err) {
      this.log.warn({ err }, "regenerate: ws_events truncation failed");
    }

    // Hermes-side: roll back its in-memory history one turn so the next
    // prompt.submit doesn't include the (now-gone) prior assistant
    // response in the conversation context. session.undo removes the last
    // assistant + tool messages AND the last user.message; we'll re-issue
    // both via the chat.send flow that follows.
    try {
      const sharedClient = this.deps.wsPool.getOrCreateShared();
      const rows = await this.deps.db
        .select({ hsid: appSessions.hermesSessionId })
        .from(appSessions)
        .where(eq(appSessions.id, appSessionId))
        .limit(1);
      const hsid = rows[0]?.hsid;
      if (hsid) {
        await sharedClient.request("session.undo", { session_id: hsid });
      }
    } catch (err) {
      this.log.warn({ err }, "regenerate: session.undo failed");
    }
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
    if (this.detachIosTools) {
      this.detachIosTools();
      this.detachIosTools = null;
    }
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
  blobRoot: string,
  chatRunTimer: ChatRunTimer | undefined,
  liveActivityPusher: LiveActivityPusher | undefined,
  chatCompleteNotifier: ChatCompleteNotifier | undefined,
): Promise<void> {
  const hsid = ev.session_id;
  if (!hsid) {
    log.info({ type: ev.type }, "upstream event has no session_id");
    return;
  }
  const appSessionId = await reverse.lookup(hsid);
  if (!appSessionId) {
    log.info({ hsid, type: ev.type }, "upstream event for unmapped session");
    return;
  }
  log.info({ hsid, appSessionId, type: ev.type }, "upstream event relayed");
  // Phase 7: record per-run timing transitions. Errors flush as "errored" so
  // we still get a chat_run log line for failed runs.
  if (chatRunTimer) {
    if (ev.type === "message.start") {
      chatRunTimer.recordRunStart(appSessionId);
    } else if (ev.type === "message.complete") {
      const stats = chatRunTimer.recordRunComplete(appSessionId, "completed");
      if (stats && chatCompleteNotifier) {
        void chatCompleteNotifier
          .maybePush({ appSessionId, durationMs: stats.durationMs, payload: ev.payload })
          .catch((err: unknown) => log.warn({ err }, "chat-complete maybePush failed"));
      }
    } else if (ev.type === "error") {
      chatRunTimer.recordRunComplete(appSessionId, "errored");
    } else {
      chatRunTimer.recordEvent(appSessionId, ev.type);
    }
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
    // TTS bridge (assistant message path): Hermes' text_to_speech tool emits a
    // `MEDIA:<path>` line embedded in the assistant message text — that's the
    // protocol it uses for messaging-platform layers (Telegram, Discord) to
    // intercept and replace with an audio attachment. We do the same: pull the
    // path out, strip the line so it doesn't render as raw text, relocate the
    // blob, and attach audio fields to the assistant.message row + envelope.
    if (ev.type === "message.complete") {
      const payloadObj =
        ev.payload && typeof ev.payload === "object"
          ? (ev.payload as Record<string, unknown>)
          : null;
      if (payloadObj) {
        const stripped = extractMediaFromMessageText(payloadObj["text"]);
        if (stripped.absPath) {
          // `||` not `??` so an empty-string env (e.g. `HERMES_HOME=` literally
          // in .env on bare-metal where the gateway shares fs with hermes) also
          // falls back to the default rather than producing a broken mount path.
          const hermesHome = process.env["HERMES_HOME"] || "/data/hermes-home";
          const accessible = translateHermesPath(stripped.absPath, hermesHome);
          let relocated: Awaited<ReturnType<typeof relocateTtsBlob>> = null;
          if (accessible) {
            relocated = await relocateTtsBlob(accessible, blobRoot, log);
            if (!relocated) {
              log.warn(
                { absPath: stripped.absPath },
                "tts-bridge: message.complete blob relocation failed; persisting stripped text only",
              );
            }
          } else {
            log.warn(
              { absPath: stripped.absPath },
              "tts-bridge: message.complete media path not accessible to gateway",
            );
          }
          // Build enriched payload: stripped text always, audio fields when relocated.
          const enriched: Record<string, unknown> = {
            ...payloadObj,
            text: stripped.text,
          };
          if (relocated) {
            enriched["audio_blob_url"] = `/voice-blobs/${relocated.relKey}`;
            enriched["audio_duration_ms"] = relocated.durationMs;
            enriched["audio_peaks"] = relocated.peaks;
          }
          const env = await appendEvent(db, {
            appSessionId,
            type: ev.type,
            payload: enriched,
          });
          registry.emit(appSessionId, env);
          await appendHistory(
            db,
            appSessionId,
            "assistant.message",
            enriched,
            undefined,
            relocated
              ? {
                  audio: {
                    blobPath: relocated.relKey,
                    durationMs: relocated.durationMs,
                    peaks: relocated.peaks,
                  },
                }
              : undefined,
          );
          // Auto-title still runs on the first assistant turn — feed it the
          // enriched payload so the title is derived from the stripped text.
          void maybeReplaceFirstTurnTitle(
            db,
            appSessionId,
            enriched,
            log,
          ).catch((err: unknown) => log.warn({ err }, "auto-title (smart) failed"));
          if (liveActivityPusher) {
            void pushLiveActivityForEvent(
              db,
              appSessionId,
              { ...ev, payload: enriched as JsonValue },
              liveActivityPusher,
              log,
            ).catch((err: unknown) =>
              log.warn({ err }, "live-activity push dispatch failed (tts-message)"),
            );
          }
          return;
        }
      }
    }
    // TTS bridge (tool.complete path — defensive): some Hermes builds may
    // surface the tool result in the tool.complete payload directly. Today
    // the canonical path is via message.complete above, but we keep this
    // intercept so an upstream change wouldn't silently break audio rendering.
    if (ev.type === "tool.complete") {
      const media = extractTtsMedia(ev.payload);
      if (media) {
        const hermesHome = process.env["HERMES_HOME"] ?? "/data/hermes-home";
        const accessible = translateHermesPath(media.absPath, hermesHome);
        if (accessible) {
          const relocated = await relocateTtsBlob(accessible, blobRoot, log);
          if (relocated) {
            // Mutate the payload object once so both the DB record and the live
            // envelope carry the audio fields. Clients and replay both read from
            // the same source.
            const enriched: Record<string, unknown> =
              ev.payload && typeof ev.payload === "object"
                ? { ...(ev.payload as Record<string, unknown>) }
                : {};
            enriched["audio_blob_url"] = `/voice-blobs/${relocated.relKey}`;
            enriched["audio_duration_ms"] = relocated.durationMs;
            enriched["audio_peaks"] = relocated.peaks;

            const env = await appendEvent(db, {
              appSessionId,
              type: ev.type,
              payload: enriched,
            });
            registry.emit(appSessionId, env);

            // Persist chat_history row with audio columns populated.
            await appendHistory(db, appSessionId, "tool.call", enriched, undefined, {
              audio: {
                blobPath: relocated.relKey,
                durationMs: relocated.durationMs,
                peaks: relocated.peaks,
              },
            });

            // Live Activity push (same as the default path below).
            if (liveActivityPusher) {
              void pushLiveActivityForEvent(
                db,
                appSessionId,
                { ...ev, payload: enriched as JsonValue },
                liveActivityPusher,
                log,
              ).catch((err: unknown) =>
                log.warn({ err }, "live-activity push dispatch failed (tts)"),
              );
            }
            return;
          }
        }
        // Relocation failed — fall through to normal persist path so the
        // tool.call row is still recorded (without audio fields).
        log.warn({ absPath: media.absPath }, "tts-bridge: blob relocation failed; persisting without audio");
      }
    }

    const env = await appendEvent(db, {
      appSessionId,
      type: ev.type,
      payload: ev.payload ?? null,
    });
    registry.emit(appSessionId, env);
    await maybePersistHistory(db, appSessionId, ev.type, ev.payload, log);
    // After the first assistant turn lands in chat_history, replace the
    // truncated-first-message title with a heuristic 4-6 word summary.
    if (ev.type === "message.complete") {
      void maybeReplaceFirstTurnTitle(db, appSessionId, ev.payload, log).catch(
        (err: unknown) => log.warn({ err }, "auto-title (smart) failed"),
      );
    }
    // Live Activity push (foregrounded JS already drives ActivityKit
    // directly; this covers the suspended/locked case).
    if (liveActivityPusher) {
      void pushLiveActivityForEvent(
        db,
        appSessionId,
        ev,
        liveActivityPusher,
        log,
      ).catch((err: unknown) =>
        log.warn({ err }, "live-activity push dispatch failed"),
      );
    }
  } catch (err) {
    log.error({ err, type: ev.type }, "failed to persist upstream event");
  }
}

// Detect "this was the first assistant turn" by counting assistant.message
// rows in chat_history; the row we just appended is included, so first turn
// → count === 1. On hit, derive a smarter title from the user's first
// message and write it to app_sessions.title_override (overwriting the
// truncated-first-message default `maybeAutoTitle` set on chat.send).
async function maybeReplaceFirstTurnTitle(
  db: Db,
  appSessionId: string,
  payload: unknown,
  log: AppLogger,
): Promise<void> {
  // Bail early if Hermes' message.complete didn't carry assistant text.
  const assistantText =
    payload && typeof payload === "object"
      ? typeof (payload as Record<string, unknown>).text === "string"
        ? ((payload as Record<string, unknown>).text as string)
        : ""
      : "";

  const rows = await db
    .select({ id: chatHistory.id, payloadJson: chatHistory.payloadJson })
    .from(chatHistory)
    .where(
      and(
        eq(chatHistory.appSessionId, appSessionId),
        eq(chatHistory.kind, "assistant.message"),
      ),
    );
  if (rows.length !== 1) return; // not the first assistant turn

  const userRows = await db
    .select({ payloadJson: chatHistory.payloadJson })
    .from(chatHistory)
    .where(
      and(
        eq(chatHistory.appSessionId, appSessionId),
        eq(chatHistory.kind, "user.message"),
      ),
    )
    .orderBy(chatHistory.id)
    .limit(1);
  const firstUserPayloadJson = userRows[0]?.payloadJson;
  if (!firstUserPayloadJson) return;
  let firstUserText = "";
  try {
    const parsed = JSON.parse(firstUserPayloadJson) as Record<string, unknown>;
    const t = parsed["text"];
    if (typeof t === "string") firstUserText = t;
  } catch {
    return;
  }
  const smart = deriveTitleFromTurn(firstUserText, assistantText);
  if (!smart) return;

  // Only overwrite when the existing title is the truncated first-message
  // default (or unset). If the user manually renamed already, leave it.
  const sessionRows = await db
    .select({
      titleOverride: appSessions.titleOverride,
    })
    .from(appSessions)
    .where(eq(appSessions.id, appSessionId))
    .limit(1);
  const cur = sessionRows[0]?.titleOverride ?? null;
  const truncatedDefault = firstUserText.length <= 60
    ? firstUserText.trim()
    : firstUserText.trim().slice(0, 57) + "…";
  const isAutoDefault = cur === truncatedDefault || cur === null;
  if (!isAutoDefault) return;

  const now = Math.floor(Date.now() / 1000);
  await db
    .update(appSessions)
    .set({ titleOverride: smart, updatedAt: now })
    .where(eq(appSessions.id, appSessionId));
  log.info({ appSessionId, title: smart }, "auto-titled session");
}

// Clear every cached hermes_session_id in the DB and reverse cache. Called
// on each upstream WS open (boot or reconnect) — see comment at the call
// site for why this is necessary (Hermes' transport-pinning quirk).
async function invalidateAllHermesSessions(
  db: Db,
  reverse: ReverseSessionMap,
  log: AppLogger,
): Promise<void> {
  try {
    const stale = await db
      .select({ id: appSessions.id, hsid: appSessions.hermesSessionId })
      .from(appSessions)
      .where(isNotNull(appSessions.hermesSessionId));
    if (stale.length === 0) return;
    const now = Math.floor(Date.now() / 1000);
    await db
      .update(appSessions)
      .set({ hermesSessionId: null, updatedAt: now })
      .where(isNotNull(appSessions.hermesSessionId));
    for (const row of stale) {
      if (row.hsid) reverse.invalidate(row.hsid);
    }
    log.info({ cleared: stale.length }, "invalidated stale hermes session mappings on upstream connect");
  } catch (err) {
    log.warn({ err }, "failed to invalidate stale hermes session mappings");
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

// ─── Live Activity push relay ────────────────────────────────────────────
//
// Maps an upstream Hermes event onto an ActivityKit content-state and
// pushes via APNs to whichever device(s) registered a token for this
// session. Best-effort — we don't fail the upstream relay on push errors.
//
// Throttling: a per-(session, type) suppression cache so a tool burst
// doesn't trip APNs' rate limits. APNs caps live-activity pushes around
// 4-6 per second across the whole app; we self-cap at 1 per 500ms per
// session.
const _laLastPush = new Map<string, number>();
function _laShouldPush(sessionId: string): boolean {
  const now = Date.now();
  const t = _laLastPush.get(sessionId) ?? 0;
  if (now - t < 500) return false;
  _laLastPush.set(sessionId, now);
  return true;
}

async function pushLiveActivityForEvent(
  db: Db,
  appSessionId: string,
  ev: HermesEventParams,
  pusher: LiveActivityPusher,
  log: AppLogger,
): Promise<void> {
  if (!pusher.isEnabled()) return;
  // Resolve content-state shape from the upstream event.
  const payload = (ev.payload ?? {}) as Record<string, unknown>;
  const asString = (k: string): string | undefined =>
    typeof payload[k] === "string" ? (payload[k] as string) : undefined;
  let kind: "chat" | "approval" = "chat";
  let status: "thinking" | "tool" | "responding" | "awaiting" = "thinking";
  let detail: string | null = null;
  let isEnd = false;
  switch (ev.type) {
    case "tool.start":
    case "tool.update":
    case "tool.progress":
    case "tool.generating": {
      status = "tool";
      detail =
        asString("name") ??
        asString("tool") ??
        asString("tool_name") ??
        "tool";
      break;
    }
    case "tool.complete": {
      status = "thinking";
      break;
    }
    case "message.delta":
    case "reasoning.available": {
      status = "responding";
      break;
    }
    case "message.complete":
    case "error": {
      isEnd = true;
      status = "responding";
      break;
    }
    case "approval.request": {
      kind = "approval";
      status = "awaiting";
      detail =
        asString("command") ??
        asString("prompt") ??
        asString("question") ??
        "Awaiting approval";
      break;
    }
    default:
      return; // ignore other event types
  }
  if (!_laShouldPush(appSessionId)) return;
  const tokens = await db
    .select({
      activityId: liveActivityTokens.activityId,
      pushToken: liveActivityTokens.pushToken,
      kind: liveActivityTokens.kind,
      createdAt: liveActivityTokens.createdAt,
    })
    .from(liveActivityTokens)
    .where(eq(liveActivityTokens.appSessionId, appSessionId));
  if (tokens.length === 0) return;
  // Use the activity's createdAt as the run start. Widget renders elapsed
  // via SwiftUI's `Text(timerInterval:)` so the timer ticks on-device — we
  // just need to feed it a stable wall-clock start.
  const startedAtEpochMs = tokens[0]
    ? tokens[0].createdAt * 1000
    : Date.now();
  const state = {
    kind,
    status,
    detail,
    startedAtEpochMs,
    modelName: null,
    updatedAtEpochMs: Date.now(),
    openUrl: `hermes://chat/${appSessionId}`,
  };
  for (const t of tokens) {
    // Activity-kind mismatch: end stale chat activity if this is an
    // approval request, and vice versa. APNs end is cheap; the JS side
    // will start the appropriate kind on its next foreground tick.
    if (t.kind !== kind && !isEnd) {
      await pusher.sendEnd(t.pushToken, state);
      continue;
    }
    if (isEnd) {
      await pusher.sendEnd(t.pushToken, state);
    } else {
      await pusher.sendUpdate(t.pushToken, state);
    }
  }
  if (isEnd) {
    // Best-effort cleanup so we don't keep pushing to dead activities.
    try {
      await db
        .delete(liveActivityTokens)
        .where(eq(liveActivityTokens.appSessionId, appSessionId));
    } catch (err) {
      log.warn({ err }, "live-activity tokens cleanup failed");
    }
  }
}
