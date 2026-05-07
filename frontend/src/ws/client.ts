import { Backoff } from "../util/backoff";
import { mockOfflineActive } from "../state/dev-settings";
import {
  type ClientFrame,
  type ControlFrame,
  type ControlFrameType,
  type GatewayEventEnvelope,
  isControlFrame,
  isEnvelope,
} from "./events";

// GatewayWsClient — framework-agnostic transport layer. Pure JS / no React.
// Lifecycle:
//   connect() opens a socket, sends `lastEventId` via URL on first connect.
//   On unexpected close, schedules reconnect with capped backoff (1s..30s).
//   On reconnect, gateway will replay events whose id > our cached lastEventId.
//   `control.sync.required` flips the client into a paused state — caller must
//   acknowledge() (after reloading session via REST) before reconnects resume.
//   401-style closes (4401) bubble as `auth_required` so the UI can refresh+retry.

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "sync_required"
  | "auth_required"
  | "closed";

export interface GatewayWsConfig {
  wsUrl: string;
  appSessionId: string;
  getToken: () => string | null;
  initialLastEventId?: number;
  /**
   * Called when the socket lands in an auth-failed state (4401 close or
   * connect-time missing token). Should return a fresh access token, or null
   * if the user must re-authenticate. After resolving, the WS client calls
   * `getToken()` again — implementations are expected to have updated the
   * token store before returning.
   *
   * Coalesce concurrent callers in the implementation; the WS client may
   * fire this in parallel with HTTP `apiFetch` calls hitting their own
   * 401-refresh path.
   */
  onAuthRequired?: () => Promise<string | null>;
}

export type EventHandler = (env: GatewayEventEnvelope) => void;
export type ControlHandler = (frame: ControlFrame) => void;
export type StatusHandler = (status: ConnectionStatus, info?: { retryInMs?: number }) => void;
/**
 * Called for every successfully-parsed incoming frame that is neither a
 * GatewayEventEnvelope nor a ControlFrame. Return true to signal that the
 * frame was handled (short-circuits subsequent raw-frame handlers). Return
 * false to pass it along.
 */
export type RawFrameHandler = (frame: unknown) => boolean;

export class GatewayWsClient {
  private readonly cfg: GatewayWsConfig;
  private socket: WebSocket | null = null;
  private lastEventId: number;
  private status: ConnectionStatus = "idle";
  private readonly backoff = new Backoff({ baseMs: 1_000, maxMs: 30_000 });
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private explicitlyClosed = false;
  private paused = false; // sync.required latched
  // Guard against tight refresh loops: if a refresh succeeds but the new token
  // also produces a 4401, we treat that as terminal auth failure (something is
  // wrong server-side — re-issuing won't help). Reset to false on any "open".
  private refreshAttempted = false;

  private readonly eventHandlers = new Set<EventHandler>();
  private readonly controlHandlers = new Set<ControlHandler>();
  private readonly statusHandlers = new Set<StatusHandler>();
  private readonly rawFrameHandlers = new Set<RawFrameHandler>();

  constructor(cfg: GatewayWsConfig) {
    this.cfg = cfg;
    this.lastEventId = cfg.initialLastEventId ?? 0;
  }

  onEvent(fn: EventHandler): () => void {
    this.eventHandlers.add(fn);
    return () => this.eventHandlers.delete(fn);
  }

  onControl(fn: ControlHandler): () => void {
    this.controlHandlers.add(fn);
    return () => this.controlHandlers.delete(fn);
  }

  onStatus(fn: StatusHandler): () => void {
    this.statusHandlers.add(fn);
    return () => this.statusHandlers.delete(fn);
  }

  /**
   * Register a handler for incoming frames that are neither event envelopes
   * nor control frames (e.g. ios_tool_call). Handlers are tried in insertion
   * order; the first one that returns true stops the chain.
   * Returns an unsubscribe function.
   */
  onRawFrame(fn: RawFrameHandler): () => void {
    this.rawFrameHandlers.add(fn);
    return () => this.rawFrameHandlers.delete(fn);
  }

  /**
   * Send a pre-serialized JSON string directly over the open WebSocket.
   * Unlike `send()`, this bypasses the ClientFrame type constraint and is
   * intended for system frames (e.g. ios_tool_result) that the server
   * expects from the mobile app but are not part of the client→server
   * event API.
   * No-ops when the socket is not open.
   */
  sendRaw(serialized: string): void {
    const s = this.socket;
    if (!s || s.readyState !== WebSocket.OPEN) return;
    s.send(serialized);
  }

  getLastEventId(): number {
    return this.lastEventId;
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  // After a sync.required the caller reloads from REST and calls this; the
  // resulting connection will not resume — we drop lastEventId to start fresh.
  acknowledgeSyncRequired(): void {
    if (this.status !== "sync_required") return;
    this.lastEventId = 0;
    this.paused = false;
    this.scheduleReconnect(0);
  }

  connect(): void {
    this.explicitlyClosed = false;
    this.openSocket();
  }

  send(frame: ClientFrame): void {
    // Dev-only mock-offline trap. Behaves identically to a real "socket
    // not OPEN" — frame is dropped, queue-drainer takes over on toggle-off.
    if (mockOfflineActive()) return;
    const s = this.socket;
    if (!s || s.readyState !== WebSocket.OPEN) return;
    s.send(JSON.stringify(frame));
  }

  close(): void {
    this.explicitlyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const s = this.socket;
    this.socket = null;
    if (s) {
      try {
        s.close(1000, "client_close");
      } catch {
        // ignore
      }
    }
    this.setStatus("closed");
  }

  // Drives the auth-failure recovery flow. Calls the configured refresh
  // callback (typically `attemptRefresh` from api/client.ts) and, on success,
  // re-enters the connect path. Bails to terminal `auth_required` if the
  // callback isn't configured, refresh fails, or this is the second auth
  // failure within the current connection lifetime.
  private async tryRefreshAndReconnect(): Promise<void> {
    if (this.explicitlyClosed || this.paused) return;
    if (this.refreshAttempted || !this.cfg.onAuthRequired) {
      this.setStatus("auth_required");
      return;
    }
    this.refreshAttempted = true;
    this.setStatus("reconnecting");
    let fresh: string | null = null;
    try {
      fresh = await this.cfg.onAuthRequired();
    } catch {
      fresh = null;
    }
    if (this.explicitlyClosed) return;
    if (!fresh) {
      this.setStatus("auth_required");
      return;
    }
    // Token store is updated by the callback; openSocket re-reads via getToken.
    this.scheduleReconnect(0);
  }

  private openSocket(): void {
    if (this.paused || this.explicitlyClosed) return;
    // Dev-only mock-offline: refuse to connect; surface as "reconnecting"
    // so the rest of the UI (status banner, etc.) treats it like a real
    // outage. A subsequent reconnect attempt is scheduled so the socket
    // wakes up the moment the user flips the toggle off.
    if (mockOfflineActive()) {
      this.setStatus("reconnecting", { retryInMs: 2000 });
      this.scheduleReconnect(2000);
      return;
    }
    const token = this.cfg.getToken();
    if (!token) {
      // No token at connect time: try refresh once before giving up. Common
      // path on cold-start when an HTTP call hasn't yet triggered the
      // reactive 401-refresh loop.
      void this.tryRefreshAndReconnect();
      return;
    }
    this.setStatus(this.lastEventId > 0 ? "reconnecting" : "connecting");

    const params = new URLSearchParams();
    params.append("token", token);
    params.append("app_session_id", this.cfg.appSessionId);
    if (this.lastEventId > 0) params.append("lastEventId", String(this.lastEventId));
    const url = `${this.cfg.wsUrl}/ws?${params.toString()}`;

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = (): void => {
      this.backoff.reset();
      this.refreshAttempted = false;
      this.setStatus("open");
    };

    socket.onmessage = (ev: MessageEvent): void => {
      this.handleMessage(ev.data);
    };

    socket.onerror = (): void => {
      // RN WebSocket fires onerror with a synthetic event — onclose follows.
    };

    socket.onclose = (ev: CloseEvent): void => {
      this.socket = null;
      if (this.explicitlyClosed) return;
      // 4401 = backend rejected our access token. First time: try a refresh
      // and reconnect with the new token. Subsequent failures within the same
      // connection lifetime mean refresh isn't fixing it (refresh token also
      // expired / revoked) — surface as terminal `auth_required` so the route
      // guard can route to login.
      if (ev.code === 4401) {
        void this.tryRefreshAndReconnect();
        return;
      }
      // 1000 with explicitlyClosed=false shouldn't happen but treat as closed.
      if (ev.code === 1000 && !this.explicitlyClosed) {
        this.scheduleReconnect();
        return;
      }
      this.scheduleReconnect();
    };
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (isEnvelope(parsed)) {
      // id=-1 marks live-only fanout (not persisted, not resumable).
      if (parsed.id > 0 && parsed.id > this.lastEventId) {
        this.lastEventId = parsed.id;
      }
      for (const fn of this.eventHandlers) fn(parsed);
      return;
    }
    if (isControlFrame(parsed)) {
      this.handleControl(parsed);
      return;
    }
    // Dispatch to raw-frame handlers (e.g. ios_tool_call). Stop at the first
    // handler that returns true.
    for (const fn of this.rawFrameHandlers) {
      if (fn(parsed)) return;
    }
  }

  private handleControl(frame: ControlFrame): void {
    if (frame.type === "sync.required") {
      this.paused = true;
      this.setStatus("sync_required");
      // Detach the live socket — caller must acknowledge() to resume.
      const s = this.socket;
      this.socket = null;
      if (s) {
        try {
          s.close(1000, "sync_required_ack_pending");
        } catch {
          // ignore
        }
      }
    }
    for (const fn of this.controlHandlers) fn(frame);
  }

  private scheduleReconnect(overrideMs?: number): void {
    if (this.explicitlyClosed || this.paused) return;
    const delay = overrideMs ?? this.backoff.next();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.setStatus("reconnecting", { retryInMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private setStatus(status: ConnectionStatus, info?: { retryInMs?: number }): void {
    if (this.status === status && !info) return;
    this.status = status;
    for (const fn of this.statusHandlers) fn(status, info);
  }
}

export type { ControlFrameType };
