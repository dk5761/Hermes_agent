import crypto from "node:crypto";
import { WebSocket } from "undici";
import type { AppLogger } from "../logger.js";
import type { ProcessLauncher } from "./launcher.js";
import {
  HermesRpcError,
  type HermesEventParams,
  type JsonRpcEventFrame,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonValue,
} from "./types.js";

export type HermesEventListener = (event: HermesEventParams) => void;
export type HermesConnectionListener = (state: "open" | "closed" | "error", info?: unknown) => void;

interface PendingRequest {
  resolve: (v: JsonValue) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export interface HermesWsClientDeps {
  launcher: ProcessLauncher;
  logger: AppLogger;
  requestTimeoutMs: number;
}

// One JSON-RPC WebSocket connection to upstream Hermes /api/ws.
// Owns: id->pending map, event subscribers, auto-reconnect.
export class HermesWsClient {
  private readonly launcher: ProcessLauncher;
  private readonly log: AppLogger;
  private readonly requestTimeoutMs: number;
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private eventListeners = new Set<HermesEventListener>();
  private connectionListeners = new Set<HermesConnectionListener>();
  private reconnectAttempts = 0;
  private closing = false;
  private connectingPromise: Promise<void> | null = null;
  // Buffered until WS opens. Hermes is local — buffer is small in practice.
  private outboundQueue: string[] = [];

  constructor(deps: HermesWsClientDeps) {
    this.launcher = deps.launcher;
    this.log = deps.logger.child({ component: "hermes-ws" });
    this.requestTimeoutMs = deps.requestTimeoutMs;
  }

  onEvent(listener: HermesEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onConnection(listener: HermesConnectionListener): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    if (this.isOpen()) return;
    if (this.connectingPromise) return this.connectingPromise;
    this.connectingPromise = this.connectInner().finally(() => {
      this.connectingPromise = null;
    });
    return this.connectingPromise;
  }

  private async connectInner(): Promise<void> {
    const state = await this.launcher.getState();
    const url = new URL("/api/ws", state.baseUrl);
    url.searchParams.set("token", state.token);
    // Convert http(s):// → ws(s):// per WHATWG.
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    this.log.info({ url: url.origin + url.pathname }, "opening upstream WS");
    const ws = new WebSocket(url);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        ws.removeEventListener("error", onError);
        resolve();
      };
      const onError = (ev: Event): void => {
        ws.removeEventListener("open", onOpen);
        reject(new Error(`upstream_ws_open_failed: ${describeEvent(ev)}`));
      };
      ws.addEventListener("open", onOpen, { once: true });
      ws.addEventListener("error", onError, { once: true });
    });
    this.attachHandlers(ws);
    this.reconnectAttempts = 0;
    this.flushQueue();
    this.notifyConnection("open");
  }

  private attachHandlers(ws: WebSocket): void {
    ws.addEventListener("message", (ev) => {
      const data = ev.data;
      const text = typeof data === "string" ? data : "";
      if (!text) return;
      // Hermes is line-delimited JSON (one frame per WS message).
      this.handleFrame(text);
    });
    ws.addEventListener("close", (ev) => {
      this.log.warn({ code: ev.code, reason: ev.reason }, "upstream WS closed");
      this.ws = null;
      this.failAllPending(new Error(`upstream_ws_closed_${ev.code}`));
      this.notifyConnection("closed", { code: ev.code, reason: ev.reason });
      if (!this.closing) this.scheduleReconnect();
    });
    ws.addEventListener("error", (ev) => {
      this.log.warn({ ev: describeEvent(ev) }, "upstream WS error");
      this.notifyConnection("error", describeEvent(ev));
    });
  }

  private handleFrame(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.log.warn({ text: text.slice(0, 200) }, "upstream WS sent non-JSON");
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const obj = parsed as Record<string, unknown>;

    // JSON-RPC response (has matching id).
    if (typeof obj["id"] === "string" && (obj["result"] !== undefined || obj["error"] !== undefined)) {
      const resp = obj as unknown as JsonRpcResponse;
      this.resolvePending(resp);
      return;
    }
    // Event notification: {method:"event", params:{type, session_id?, payload?}}
    if (obj["method"] === "event" && typeof obj["params"] === "object" && obj["params"] !== null) {
      const frame = obj as unknown as JsonRpcEventFrame;
      for (const fn of this.eventListeners) {
        try {
          fn(frame.params);
        } catch (err) {
          this.log.error({ err }, "ws event listener threw");
        }
      }
      return;
    }
    // Some Hermes builds emit non-JSON-RPC plain {type, session_id, payload}.
    if (typeof obj["type"] === "string") {
      const synthetic: HermesEventParams = {
        type: String(obj["type"]),
        payload: (obj["payload"] ?? null) as JsonValue,
      };
      if (typeof obj["session_id"] === "string") {
        synthetic.session_id = obj["session_id"];
      }
      for (const fn of this.eventListeners) {
        try {
          fn(synthetic);
        } catch (err) {
          this.log.error({ err }, "ws event listener threw");
        }
      }
    }
  }

  private resolvePending(resp: JsonRpcResponse): void {
    const pending = this.pending.get(resp.id);
    if (!pending) {
      this.log.debug({ id: resp.id }, "no pending request for response id");
      return;
    }
    this.pending.delete(resp.id);
    clearTimeout(pending.timer);
    if ("error" in resp) {
      pending.reject(new HermesRpcError(resp.error.code, resp.error.message, resp.error.data));
    } else {
      pending.resolve(resp.result);
    }
  }

  // Send a JSON-RPC request and await response.
  async request<R = JsonValue>(method: string, params: Record<string, JsonValue> = {}): Promise<R> {
    await this.connect();
    const id = crypto.randomUUID();
    const frame: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const promise = new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`upstream_request_timeout:${method}`));
        }
      }, this.requestTimeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer, method });
    });
    this.send(JSON.stringify(frame));
    return promise as Promise<R>;
  }

  // Fire-and-forget notification (no response expected).
  notify(method: string, params: Record<string, JsonValue> = {}): void {
    const frame = { jsonrpc: "2.0" as const, method, params };
    this.send(JSON.stringify(frame));
  }

  private send(text: string): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(text);
      return;
    }
    this.outboundQueue.push(text);
    void this.connect();
  }

  private flushQueue(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    for (const t of this.outboundQueue) this.ws.send(t);
    this.outboundQueue = [];
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts += 1;
    const delay = Math.min(2000 * 2 ** Math.min(this.reconnectAttempts, 5), 30_000);
    this.log.info({ delay, attempt: this.reconnectAttempts }, "scheduling upstream WS reconnect");
    setTimeout(() => {
      if (this.closing) return;
      this.connect().catch((err: unknown) => {
        this.log.warn({ err }, "upstream WS reconnect failed");
      });
    }, delay).unref();
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private notifyConnection(state: "open" | "closed" | "error", info?: unknown): void {
    for (const fn of this.connectionListeners) {
      try {
        fn(state, info);
      } catch (err) {
        this.log.error({ err }, "ws connection listener threw");
      }
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    this.failAllPending(new Error("client_closing"));
    if (this.ws) {
      try {
        this.ws.close(1000, "client_closing");
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }
}

function describeEvent(ev: Event): string {
  if (typeof ev === "object" && ev !== null && "message" in ev) {
    const m = (ev as unknown as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return ev.type ?? "unknown";
}
