import { request } from "undici";
import type { AppLogger } from "../logger.js";
import {
  HermesAuthError,
  HermesMessagesResponseSchema,
  HermesSessionInfoSchema,
  HermesSessionListSchema,
  HermesUpstreamError,
  type HermesMessagesResponse,
  type HermesSessionInfo,
  type HermesSessionList,
} from "./types.js";
import type { ProcessLauncher } from "./launcher.js";

export interface HermesHttpClientDeps {
  launcher: ProcessLauncher;
  logger: AppLogger;
  requestTimeoutMs: number;
}

interface HermesRequestOpts {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  // Upstream endpoints that Hermes serves without a token (per HERMES_CONTRACT.md).
  publicNoAuth?: boolean;
}

const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  "/api/status",
  "/api/config/defaults",
  "/api/config/schema",
  "/api/model/info",
  "/api/dashboard/themes",
]);

// Typed wrapper around upstream Hermes REST API.
// Auto-refreshes the session token + retries once on 401.
export class HermesHttpClient {
  private readonly launcher: ProcessLauncher;
  private readonly log: AppLogger;
  private readonly requestTimeoutMs: number;

  constructor(deps: HermesHttpClientDeps) {
    this.launcher = deps.launcher;
    this.log = deps.logger.child({ component: "hermes-http" });
    this.requestTimeoutMs = deps.requestTimeoutMs;
  }

  async raw(path: string, opts: HermesRequestOpts = {}): Promise<{ status: number; body: string }> {
    return this.callWithRetry(path, opts);
  }

  async getJson<T = unknown>(path: string, opts: Omit<HermesRequestOpts, "method"> = {}): Promise<T> {
    const { body, status } = await this.callWithRetry(path, { ...opts, method: "GET" });
    return this.parseBody<T>(path, status, body);
  }

  async postJson<T = unknown>(
    path: string,
    body: unknown,
    opts: Omit<HermesRequestOpts, "method" | "body"> = {},
  ): Promise<T> {
    const res = await this.callWithRetry(path, { ...opts, method: "POST", body });
    return this.parseBody<T>(path, res.status, res.body);
  }

  async putJson<T = unknown>(
    path: string,
    body: unknown,
    opts: Omit<HermesRequestOpts, "method" | "body"> = {},
  ): Promise<T> {
    const res = await this.callWithRetry(path, { ...opts, method: "PUT", body });
    return this.parseBody<T>(path, res.status, res.body);
  }

  async patchJson<T = unknown>(
    path: string,
    body: unknown,
    opts: Omit<HermesRequestOpts, "method" | "body"> = {},
  ): Promise<T> {
    const res = await this.callWithRetry(path, { ...opts, method: "PATCH", body });
    return this.parseBody<T>(path, res.status, res.body);
  }

  async deleteJson<T = unknown>(path: string, opts: Omit<HermesRequestOpts, "method"> = {}): Promise<T> {
    const res = await this.callWithRetry(path, { ...opts, method: "DELETE" });
    if (res.status === 404) {
      // Caller-tolerated 404 — surface a typed error.
      throw new HermesUpstreamError(404, "not_found", res.body);
    }
    return this.parseBody<T>(path, res.status, res.body);
  }

  // Convenience typed methods used by route handlers / WS bridge.
  async listSessions(params: { limit?: number; offset?: number }): Promise<HermesSessionList> {
    const raw = await this.getJson("/api/sessions", { query: params });
    return HermesSessionListSchema.parse(raw);
  }

  async getSession(id: string): Promise<HermesSessionInfo> {
    const raw = await this.getJson(`/api/sessions/${encodeURIComponent(id)}`);
    return HermesSessionInfoSchema.parse(raw);
  }

  async getSessionMessages(id: string): Promise<HermesMessagesResponse> {
    const raw = await this.getJson(`/api/sessions/${encodeURIComponent(id)}/messages`);
    return HermesMessagesResponseSchema.parse(raw);
  }

  async deleteSession(id: string): Promise<void> {
    try {
      await this.deleteJson(`/api/sessions/${encodeURIComponent(id)}`);
    } catch (err) {
      if (err instanceof HermesUpstreamError && err.status === 404) {
        // Tolerate 404s per Phase 2 contract — gateway-side row may outlive Hermes-side.
        this.log.debug({ id }, "deleteSession 404 from upstream — tolerating");
        return;
      }
      throw err;
    }
  }

  async searchSessions(q: string): Promise<unknown> {
    return this.getJson("/api/sessions/search", { query: { q } });
  }

  // ---- Cron ----
  async listCronJobs(): Promise<unknown> {
    return this.getJson("/api/cron/jobs");
  }
  async getCronJob(id: string): Promise<unknown> {
    return this.getJson(`/api/cron/jobs/${encodeURIComponent(id)}`);
  }
  async createCronJob(body: unknown): Promise<unknown> {
    return this.postJson("/api/cron/jobs", body);
  }
  async updateCronJob(id: string, body: unknown): Promise<unknown> {
    return this.putJson(`/api/cron/jobs/${encodeURIComponent(id)}`, body);
  }
  async cronJobAction(id: string, action: "pause" | "resume" | "trigger"): Promise<unknown> {
    return this.postJson(`/api/cron/jobs/${encodeURIComponent(id)}/${action}`, {});
  }
  async deleteCronJob(id: string): Promise<void> {
    try {
      await this.deleteJson(`/api/cron/jobs/${encodeURIComponent(id)}`);
    } catch (err) {
      if (err instanceof HermesUpstreamError && err.status === 404) return;
      throw err;
    }
  }

  // ---- Misc public/auth-ed proxies ----
  async modelInfo(): Promise<unknown> {
    return this.getJson("/api/model/info", { publicNoAuth: true });
  }
  async listSkills(): Promise<unknown> {
    return this.getJson("/api/skills");
  }
  async listToolsets(): Promise<unknown> {
    return this.getJson("/api/tools/toolsets");
  }
  async logs(query: { file?: string | undefined; lines?: number | undefined }): Promise<unknown> {
    return this.getJson("/api/logs", { query });
  }
  async analytics(query: { days?: number | undefined }): Promise<unknown> {
    return this.getJson("/api/analytics/usage", { query });
  }

  private async callWithRetry(
    path: string,
    opts: HermesRequestOpts,
  ): Promise<{ status: number; body: string }> {
    const isPublic = opts.publicNoAuth === true || PUBLIC_PATHS.has(path);
    let attempt = 0;
    let res = await this.callOnce(path, opts, isPublic);
    if (res.status === 401 && !isPublic && attempt === 0) {
      this.log.warn({ path }, "upstream 401 — refreshing token and retrying once");
      attempt += 1;
      await this.launcher.refresh();
      res = await this.callOnce(path, opts, false);
      if (res.status === 401) {
        throw new HermesAuthError("hermes_auth_failed_after_refresh");
      }
    }
    return res;
  }

  private async callOnce(
    path: string,
    opts: HermesRequestOpts,
    isPublic: boolean,
  ): Promise<{ status: number; body: string }> {
    const state = await this.launcher.getState();
    const url = new URL(path, state.baseUrl);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v === undefined) continue;
        url.searchParams.set(k, String(v));
      }
    }
    const headers: Record<string, string> = {
      Host: state.hostHeader,
      Accept: "application/json",
    };
    if (!isPublic) headers["Authorization"] = `Bearer ${state.token}`;
    const reqInit: Parameters<typeof request>[1] = {
      method: opts.method ?? "GET",
      headers,
      bodyTimeout: this.requestTimeoutMs,
      headersTimeout: this.requestTimeoutMs,
    };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      reqInit.body = JSON.stringify(opts.body);
    }
    const res = await request(url, reqInit);
    const text = await res.body.text();
    return { status: res.statusCode, body: text };
  }

  private parseBody<T>(path: string, status: number, body: string): T {
    if (status >= 200 && status < 300) {
      if (!body) return undefined as T;
      try {
        return JSON.parse(body) as T;
      } catch (err) {
        this.log.error({ err, path, body: body.slice(0, 200) }, "non-JSON body from Hermes");
        throw new HermesUpstreamError(status, "invalid_json_body", body);
      }
    }
    if (status === 401) {
      throw new HermesAuthError(`401 from ${path}`);
    }
    throw new HermesUpstreamError(status, `upstream_${status}`, body);
  }
}
