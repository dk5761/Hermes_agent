import type { AppLogger } from "../logger.js";
import type { ProcessLauncher } from "./launcher.js";
import { HermesWsClient } from "./ws-client.js";

export interface HermesWsPoolDeps {
  launcher: ProcessLauncher;
  logger: AppLogger;
  requestTimeoutMs: number;
}

interface PoolEntry {
  client: HermesWsClient;
  refCount: number;
}

// Multi-app-session pool over a single upstream Hermes process.
//
// Hermes upstream multiplexes all sessions on one /api/ws connection — it tags
// every outgoing event with `session_id`. We could in theory share ONE upstream
// WS for the entire gateway, but per the Phase 2 contract we maintain logical
// per-app-session clients so future per-session policy (rate limits, isolated
// reconnect, abort scoping) is easy to add. For now we keep one shared
// HermesWsClient under the hood and ref-count it; routing-by-session_id lives
// in the gateway WS layer that subscribes to events.
//
// If we later want true per-session isolation, swap `getOrCreate` to actually
// open a new HermesWsClient per appSessionId.
export class HermesWsPool {
  private readonly launcher: ProcessLauncher;
  private readonly log: AppLogger;
  private readonly requestTimeoutMs: number;
  private shared: PoolEntry | null = null;
  private closing = false;

  constructor(deps: HermesWsPoolDeps) {
    this.launcher = deps.launcher;
    this.log = deps.logger.child({ component: "hermes-ws-pool" });
    this.requestTimeoutMs = deps.requestTimeoutMs;
  }

  // Acquire a client. The caller must call `release()` exactly once when done.
  acquire(_appSessionId: string): { client: HermesWsClient; release: () => void } {
    if (this.closing) throw new Error("ws_pool_closing");
    if (!this.shared) {
      const client = new HermesWsClient({
        launcher: this.launcher,
        logger: this.log,
        requestTimeoutMs: this.requestTimeoutMs,
      });
      this.shared = { client, refCount: 0 };
      // Best-effort eager open; clients can also drive open via request().
      void client.connect().catch((err: unknown) => {
        this.log.warn({ err }, "upstream WS initial connect failed");
      });
    }
    this.shared.refCount += 1;
    const released = { value: false };
    return {
      client: this.shared.client,
      release: () => {
        if (released.value) return;
        released.value = true;
        if (!this.shared) return;
        this.shared.refCount = Math.max(0, this.shared.refCount - 1);
        // We deliberately keep the upstream WS open even at refCount 0 — Hermes
        // is local, the connection is cheap, and reconnect storms hurt more.
      },
    };
  }

  // Returns the shared client without ref-count adjustment. Used by the gateway
  // bridge to attach a global event listener for envelope persistence.
  getOrCreateShared(): HermesWsClient {
    if (this.closing) throw new Error("ws_pool_closing");
    if (!this.shared) {
      const client = new HermesWsClient({
        launcher: this.launcher,
        logger: this.log,
        requestTimeoutMs: this.requestTimeoutMs,
      });
      this.shared = { client, refCount: 0 };
      void client.connect().catch((err: unknown) => {
        this.log.warn({ err }, "upstream WS initial connect failed");
      });
    }
    return this.shared.client;
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.shared) {
      await this.shared.client.close();
      this.shared = null;
    }
  }
}
