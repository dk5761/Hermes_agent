import { Backoff } from "../util/backoff";
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
}

export type EventHandler = (env: GatewayEventEnvelope) => void;
export type ControlHandler = (frame: ControlFrame) => void;
export type StatusHandler = (status: ConnectionStatus, info?: { retryInMs?: number }) => void;

export class GatewayWsClient {
  private readonly cfg: GatewayWsConfig;
  private socket: WebSocket | null = null;
  private lastEventId: number;
  private status: ConnectionStatus = "idle";
  private readonly backoff = new Backoff({ baseMs: 1_000, maxMs: 30_000 });
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private explicitlyClosed = false;
  private paused = false; // sync.required latched

  private readonly eventHandlers = new Set<EventHandler>();
  private readonly controlHandlers = new Set<ControlHandler>();
  private readonly statusHandlers = new Set<StatusHandler>();

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

  private openSocket(): void {
    if (this.paused || this.explicitlyClosed) return;
    const token = this.cfg.getToken();
    if (!token) {
      this.setStatus("auth_required");
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
      // 4401 = backend signal that auth failed; surface to caller for refresh.
      if (ev.code === 4401) {
        this.setStatus("auth_required");
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
