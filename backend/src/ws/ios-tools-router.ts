// iOS native tools request/response correlator.
//
// Lifecycle:
//   1. gateway-ws or the root iOS tools WS calls registerWs(userId, ws) on
//      each authenticated WS open.
//   2. POST /internal/ios-tool calls call(userId, tool, args, timeoutMs).
//      • If WS is open: send ios_tool_call frame, await ios_tool_result.
//      • If WS is closed: fire silent push, wait up to WAKE_TIMEOUT_MS for
//        the app to reconnect, then send + await.
//      • If still not connected: enqueue call, throw IosToolError("queued").
//   3. gateway-ws calls onResult(frame) when an ios_tool_result arrives.
//   4. On register with queued items: drain + replay without a new silent push
//      (WS is already open at that point).
//
// Single-user mode for v1: userId arg is explicit everywhere so multi-user
// requires only a config change, not a refactor.

import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { Db } from "../db/client.js";
import { IosToolQueue } from "../ios-tools/queue.js";
import { SilentPusher } from "../ios-tools/silent-push.js";
import type { AppLogger } from "../logger.js";
import {
  IosToolError,
  type IosToolCallFrame,
  type IosToolErrorCode,
  type IosToolName,
  type IosToolResultFrame,
} from "../types/ios-tools.js";

const VALID_ERROR_CODES: ReadonlySet<IosToolErrorCode> = new Set([
  "offline",
  "queued",
  "timeout",
  "permission_denied",
  "unknown",
]);

function toIosToolErrorCode(raw: string): IosToolErrorCode {
  if (VALID_ERROR_CODES.has(raw as IosToolErrorCode)) return raw as IosToolErrorCode;
  return "unknown";
}

// How long to wait after sending a silent push before giving up and queuing.
const WAKE_TIMEOUT_MS = 25_000;

// How often to purge stale queue entries (every 30 minutes).
const QUEUE_SWEEP_INTERVAL_MS = 30 * 60 * 1000;

interface Pending {
  resolve: (result: Record<string, unknown>) => void;
  reject: (err: IosToolError) => void;
  timer: NodeJS.Timeout;
}

// A waiter is someone who fired a silent push and is holding on until
// registerWs is called for that user (or WAKE_TIMEOUT_MS expires).
interface WakeWaiter {
  resolve: (ws: WebSocket) => void;
  reject: () => void;
  timer: NodeJS.Timeout;
}

type SocketRole = "root" | "chat";

interface RegisteredSocket {
  ws: WebSocket;
  role: SocketRole;
}

export interface IosToolsRouterDeps {
  db: Db;
  logger: AppLogger;
  expoAccessToken?: string | undefined;
}

export class IosToolsRouter {
  private readonly log: AppLogger;
  private readonly queue: IosToolQueue;
  private readonly silentPusher: SilentPusher;

  /** userId → currently active WS connections. Root app WS and chat WS can coexist. */
  private readonly activeWs = new Map<string, Set<RegisteredSocket>>();

  /** call_id → pending result waiter. */
  private readonly pending = new Map<string, Pending>();

  /** userId → list of callers waiting for a WS to come up post-push. */
  private readonly wakeWaiters = new Map<string, WakeWaiter[]>();

  /** userIds with an in-flight queue drain. Prevents duplicate side effects. */
  private readonly drainingUsers = new Set<string>();

  private sweepHandle: NodeJS.Timeout | null = null;

  constructor(deps: IosToolsRouterDeps) {
    this.log = deps.logger.child({ component: "ios-tools-router" });
    this.queue = new IosToolQueue(deps.db);
    this.silentPusher = new SilentPusher({
      db: deps.db,
      logger: deps.logger,
      expoAccessToken: deps.expoAccessToken,
    });
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Register an authenticated WS for `userId`. Must be called by gateway-ws
   * on each successful WS handshake. Also drains any queued calls for this
   * user (since the phone is now reachable).
   *
   * Returns a cleanup function — gateway-ws must call it when the WS closes.
   */
  registerWs(userId: string, ws: WebSocket, role: SocketRole = "chat"): () => void {
    const set = this.activeWs.get(userId) ?? new Set<RegisteredSocket>();
    const registered: RegisteredSocket = { ws, role };
    set.add(registered);
    this.activeWs.set(userId, set);
    this.log.info({ userId, role }, "ios-tools-router: ws registered");

    // Resolve any callers that were waiting for this user to come online.
    this.resolveWakeWaiters(userId, ws);

    // Drain the server-side queue and replay calls over the now-live WS.
    void this.drainAndReplay(userId);

    return () => {
      const existing = this.activeWs.get(userId);
      if (existing) {
        existing.delete(registered);
      }
      if (existing && existing.size === 0) {
        this.activeWs.delete(userId);
      }
      this.log.info({ userId, role }, "ios-tools-router: ws unregistered");
    };
  }

  /**
   * Invoke a native iOS tool for `userId`. Returns the tool result payload.
   *
   * Throws IosToolError on:
   *   • "queued"  — call was persisted, will fire on next reconnect
   *   • "offline" — should not happen unless queue also fails (very rare)
   *   • "timeout" — WS was open but tool didn't respond in time
   *   • "unknown" — unexpected error from the native side
   */
  async call(
    userId: string,
    tool: IosToolName,
    args: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<Record<string, unknown>> {
    const ws = this.getOpenWs(userId);
    if (ws) {
      return this.sendOverWs(ws, tool, args, timeoutMs);
    }

    // No live WS — try to wake the app with a silent push.
    this.log.info({ userId, tool }, "ios-tools-router: no live ws, sending silent push");
    void this.silentPusher.sendSilentWake(userId);

    // Wait up to WAKE_TIMEOUT_MS for the WS to reconnect.
    let ws2: WebSocket | null = null;
    try {
      ws2 = await this.waitForWs(userId, WAKE_TIMEOUT_MS);
    } catch {
      // waitForWs rejects on timeout — fall through to queue.
    }

    if (ws2) {
      this.log.info({ userId, tool }, "ios-tools-router: app woke, sending call");
      return this.sendOverWs(ws2, tool, args, timeoutMs);
    }

    // App did not wake in time — persist to queue.
    this.log.info({ userId, tool }, "ios-tools-router: wake failed, queuing call");
    await this.queue.enqueue(userId, tool, args);
    throw new IosToolError("queued", "phone unreachable; call queued for next app open");
  }

  /**
   * Called by gateway-ws when an incoming WS frame has type "ios_tool_result".
   * Resolves or rejects the corresponding pending call.
   */
  onResult(frame: IosToolResultFrame): void {
    const pending = this.pending.get(frame.call_id);
    if (!pending) {
      // Late or duplicate — harmless.
      this.log.info({ callId: frame.call_id }, "ios-tools-router: received result for unknown call_id");
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(frame.call_id);

    if (frame.ok) {
      pending.resolve(frame.result ?? {});
    } else {
      const rawCode = frame.error?.code ?? "unknown";
      const code = toIosToolErrorCode(rawCode);
      const msg = frame.error?.message ?? "tool returned error";
      pending.reject(new IosToolError(code, msg));
    }
  }

  /**
   * Start the periodic queue-purge sweeper. Returns a stop function.
   * Call from server.ts after construction.
   */
  startSweeper(): () => void {
    const maxAgeS = parseInt(process.env["IOS_TOOL_QUEUE_MAX_AGE_S"] ?? "21600", 10);
    const effectiveMaxAge = isNaN(maxAgeS) || maxAgeS <= 0 ? 21600 : maxAgeS;

    const tick = (): void => {
      this.queue.purgeOlderThan(effectiveMaxAge).then((n) => {
        if (n > 0) {
          this.log.info({ purged: n }, "ios-tool-queue: purged stale entries");
        }
      }).catch((err: unknown) => {
        this.log.warn({ err }, "ios-tool-queue: sweep failed");
      });
    };

    this.sweepHandle = setInterval(tick, QUEUE_SWEEP_INTERVAL_MS);
    this.sweepHandle.unref();
    // Immediate sweep on start.
    tick();

    return () => {
      if (this.sweepHandle) {
        clearInterval(this.sweepHandle);
        this.sweepHandle = null;
      }
    };
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private getOpenWs(userId: string): WebSocket | null {
    const sockets = this.activeWs.get(userId);
    if (!sockets) return null;
    const ordered = Array.from(sockets);
    for (const registered of ordered) {
      if (registered.ws.readyState !== registered.ws.OPEN) {
        sockets.delete(registered);
      }
    }
    if (sockets.size === 0) {
      this.activeWs.delete(userId);
      return null;
    }
    // Prefer the app-level root socket because it stays mounted while chat
    // screens come and go. Chat sockets are kept as a compatibility fallback.
    const open = Array.from(sockets);
    return (
      open.find((registered) => registered.role === "root")?.ws ??
      open[open.length - 1]?.ws ??
      null
    );
  }

  private sendOverWs(
    ws: WebSocket,
    tool: IosToolName,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const callId = randomUUID();

    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId);
        reject(new IosToolError("timeout", `ios tool ${tool} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(callId, { resolve, reject, timer });
    });

    const frame: IosToolCallFrame = {
      type: "ios_tool_call",
      call_id: callId,
      tool,
      args,
      timeout_ms: timeoutMs,
    };

    try {
      ws.send(JSON.stringify(frame));
    } catch (err) {
      clearTimeout(this.pending.get(callId)?.timer);
      this.pending.delete(callId);
      throw new IosToolError("unknown", `ws.send failed: ${String(err)}`);
    }

    return promise;
  }

  private waitForWs(userId: string, timeoutMs: number): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove this waiter from the list.
        const waiters = this.wakeWaiters.get(userId);
        if (waiters) {
          const idx = waiters.findIndex((w) => w.timer === timer);
          if (idx !== -1) waiters.splice(idx, 1);
          if (waiters.length === 0) this.wakeWaiters.delete(userId);
        }
        reject();
      }, timeoutMs);

      const waiter: WakeWaiter = { resolve, reject, timer };
      const existing = this.wakeWaiters.get(userId);
      if (existing) {
        existing.push(waiter);
      } else {
        this.wakeWaiters.set(userId, [waiter]);
      }
    });
  }

  private resolveWakeWaiters(userId: string, ws: WebSocket): void {
    const waiters = this.wakeWaiters.get(userId);
    if (!waiters || waiters.length === 0) return;
    this.wakeWaiters.delete(userId);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(ws);
    }
  }

  private async drainAndReplay(userId: string): Promise<void> {
    if (this.drainingUsers.has(userId)) return;
    this.drainingUsers.add(userId);
    let queued: Awaited<ReturnType<IosToolQueue["drainForUser"]>>;
    try {
      queued = await this.queue.drainForUser(userId);
    } catch (err) {
      this.log.warn({ err, userId }, "ios-tools-router: queue drain failed");
      this.drainingUsers.delete(userId);
      return;
    }

    try {
      if (queued.length === 0) return;
      this.log.info({ userId, count: queued.length }, "ios-tools-router: replaying queued calls");

      for (const item of queued) {
        const ws = this.getOpenWs(userId);
        if (!ws) {
          this.log.warn({ userId }, "ios-tools-router: no open ws mid-drain, stopping replay");
          break;
        }
        try {
          const result = await this.sendOverWs(ws, item.tool, item.args, 30_000);
          this.log.info({ userId, tool: item.tool, callId: item.id }, "ios-tools-router: queued call replayed", result);
        } catch (err) {
          // Best-effort replay — log and continue. The call is already dequeued
          // so we don't re-queue to avoid infinite loops.
          this.log.warn({ err, userId, tool: item.tool }, "ios-tools-router: queued call replay failed");
        }
      }
    } finally {
      this.drainingUsers.delete(userId);
    }
  }
}
