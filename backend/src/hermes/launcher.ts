import { spawn, type ChildProcess } from "node:child_process";
import { request } from "undici";
import type { AppConfig } from "../config.js";
import type { AppLogger } from "../logger.js";

// Token regex matches the script tag injected by hermes_cli/web_server.py:2617.
const TOKEN_RE = /window\.__HERMES_SESSION_TOKEN__\s*=\s*"([^"]+)"/;

export type LauncherMode = "external" | "spawn";

export interface LauncherState {
  baseUrl: string;
  token: string;
  hostHeader: string;
}

export interface ProcessLauncherDeps {
  config: AppConfig;
  logger: AppLogger;
}

// ProcessLauncher owns the upstream Hermes process and its session token.
// In external mode it just exposes the configured token; in spawn mode it
// owns a child process, scrapes the token from the served HTML, and restarts
// the child on crash with exponential backoff.
export class ProcessLauncher {
  private readonly config: AppConfig;
  private readonly log: AppLogger;
  private readonly mode: LauncherMode;
  private state: LauncherState | null = null;
  private child: ChildProcess | null = null;
  private restartBackoffMs: number;
  private stopping = false;
  private startPromise: Promise<LauncherState> | null = null;
  private listeners: Array<(state: LauncherState) => void> = [];

  constructor(deps: ProcessLauncherDeps) {
    this.config = deps.config;
    this.log = deps.logger.child({ component: "hermes-launcher" });
    this.mode = deps.config.HERMES_LAUNCH_MODE;
    this.restartBackoffMs = deps.config.HERMES_SPAWN_RESTART_BACKOFF_MS;
  }

  getMode(): LauncherMode {
    return this.mode;
  }

  // Returns the current Hermes state, starting the process if needed.
  async getState(): Promise<LauncherState> {
    if (this.state) return this.state;
    return this.start();
  }

  // Force re-acquisition of the token (e.g. after a 401 from upstream).
  async refresh(): Promise<LauncherState> {
    if (this.mode === "external") {
      this.log.info("external Hermes returned 401; re-scraping token");
      this.state = null;
      this.startPromise = null;
      return this.start();
    }
    this.log.info("refreshing Hermes token after upstream auth failure");
    await this.killChild();
    this.state = null;
    return this.start();
  }

  onStateChange(fn: (state: LauncherState) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((f) => f !== fn);
    };
  }

  // Single-flight start; concurrent callers share one promise.
  async start(): Promise<LauncherState> {
    if (this.state) return this.state;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInner().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async startInner(): Promise<LauncherState> {
    if (this.mode === "external") {
      return this.buildExternalState();
    }
    return this.spawnAndScrape();
  }

  // External mode: prefer the explicit env token; otherwise scrape Hermes' HTML.
  // Re-scraping on 401 means a Hermes restart (token rotation) self-heals
  // without operator intervention — critical for the docker-compose dev flow.
  private async buildExternalState(): Promise<LauncherState> {
    const baseUrl = this.config.HERMES_BASE_URL;
    const explicit = process.env["HERMES_TOKEN"] ?? this.config.HERMES_TOKEN ?? "";
    let token = explicit;
    if (!token) {
      this.log.info({ baseUrl }, "scraping Hermes token from served HTML");
      token = await pollForToken(baseUrl, this.log);
    }
    const state: LauncherState = {
      baseUrl,
      token,
      hostHeader: hostHeaderFromUrl(baseUrl),
    };
    this.state = state;
    this.log.info({ baseUrl, scraped: !explicit }, "using external Hermes");
    this.notify();
    return state;
  }

  private async spawnAndScrape(): Promise<LauncherState> {
    const agentDir = this.config.HERMES_AGENT_DIR;
    if (!agentDir) {
      throw new Error("HERMES_AGENT_DIR required in spawn mode");
    }
    const port = this.config.HERMES_PORT;
    const baseUrl = `http://127.0.0.1:${port}`;
    const args = ["-m", "hermes_cli.main", "web", "--port", String(port)];

    this.log.info({ python: this.config.HERMES_PYTHON, agentDir, args }, "spawning Hermes");
    const child = spawn(this.config.HERMES_PYTHON, args, {
      cwd: agentDir,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;

    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        for (const line of chunk.split("\n")) {
          if (line.trim()) this.log.info({ stream: "stdout" }, line);
        }
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        for (const line of chunk.split("\n")) {
          if (line.trim()) this.log.warn({ stream: "stderr" }, line);
        }
      });
    }
    child.on("exit", (code, signal) => {
      this.log.warn({ code, signal }, "Hermes child exited");
      this.child = null;
      this.state = null;
      if (!this.stopping) this.scheduleRestart();
    });

    const token = await pollForToken(baseUrl, this.log);
    const state: LauncherState = {
      baseUrl,
      token,
      hostHeader: hostHeaderFromUrl(baseUrl),
    };
    this.state = state;
    this.restartBackoffMs = this.config.HERMES_SPAWN_RESTART_BACKOFF_MS;
    this.log.info({ baseUrl }, "Hermes launched and token scraped");
    this.notify();
    return state;
  }

  private scheduleRestart(): void {
    const delay = this.restartBackoffMs;
    this.restartBackoffMs = Math.min(
      this.restartBackoffMs * 2,
      this.config.HERMES_SPAWN_RESTART_MAX_BACKOFF_MS,
    );
    this.log.warn({ delay }, "scheduling Hermes restart");
    setTimeout(() => {
      if (this.stopping) return;
      this.start().catch((err: unknown) => {
        this.log.error({ err }, "Hermes restart failed");
        this.scheduleRestart();
      });
    }, delay).unref();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.killChild();
  }

  private async killChild(): Promise<void> {
    const c = this.child;
    if (!c) return;
    this.child = null;
    return new Promise<void>((resolve) => {
      const done = (): void => resolve();
      c.once("exit", done);
      try {
        c.kill("SIGTERM");
      } catch (err) {
        this.log.warn({ err }, "SIGTERM failed");
      }
      // Hard-kill after 10s grace (per Phase 2 contract).
      setTimeout(() => {
        if (c.exitCode === null) {
          try {
            c.kill("SIGKILL");
          } catch {
            // already gone
          }
        }
      }, 10_000).unref();
    });
  }

  private notify(): void {
    if (!this.state) return;
    for (const fn of this.listeners) {
      try {
        fn(this.state);
      } catch (err) {
        this.log.error({ err }, "launcher listener threw");
      }
    }
  }
}

function hostHeaderFromUrl(url: string): string {
  const u = new URL(url);
  // Match host-header middleware which expects the bound interface verbatim.
  return u.port ? `${u.hostname}:${u.port}` : u.hostname;
}

async function pollForToken(baseUrl: string, log: AppLogger): Promise<string> {
  const deadline = Date.now() + 30_000;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await request(`${baseUrl}/`, {
        method: "GET",
        headers: { Host: hostHeaderFromUrl(baseUrl) },
      });
      if (res.statusCode === 200) {
        const body = await res.body.text();
        const m = TOKEN_RE.exec(body);
        if (m && typeof m[1] === "string") {
          return m[1];
        }
        log.debug("Hermes index served but token script not found yet");
      } else {
        await res.body.dump();
      }
    } catch (err) {
      lastErr = err;
    }
    await sleep(500);
  }
  throw new Error(
    `Hermes did not become ready within 30s (lastErr=${String(lastErr ?? "none")})`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
