import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import type { ProcessLauncher } from "../hermes/launcher.js";
import type { HermesHttpClient } from "../hermes/http-client.js";
import type { HermesWsPool } from "../hermes/ws-pool.js";
import type { CleanupTasksHandle } from "../cleanup/runner.js";

export interface HealthRoutesDeps {
  requireAuth: preHandlerHookHandler;
  // Phase 7: detailed view dependencies — kept optional so this route can be
  // wired in environments that don't have all subsystems wired (tests).
  launcher?: ProcessLauncher;
  hermesHttp?: HermesHttpClient;
  wsPool?: HermesWsPool;
  cleanup?: CleanupTasksHandle;
  cronWatcherStatus?: () => { enabled: boolean; running: boolean };
}

export async function registerHealthRoutes(app: FastifyInstance, deps: HealthRoutesDeps): Promise<void> {
  // Cheap shallow check — used by Caddy/upstream probes; never touches Hermes.
  // Skipped from rate limiting via `config.rateLimit = false` so frequent ops
  // probes don't poison the limiter for real callers.
  app.get(
    "/health",
    { config: { rateLimit: false } },
    async () => ({ status: "ok", uptimeS: Math.floor(process.uptime()) }),
  );

  app.get(
    "/health/me",
    { preHandler: deps.requireAuth },
    async (request) => {
      const u = request.user;
      if (!u) {
        return { status: "error", error: "unauthenticated" };
      }
      return { status: "ok", user: { id: u.id, username: u.username } };
    },
  );

  // Phase 7: ops-facing detailed health snapshot. Auth-required to avoid
  // leaking subsystem state. Probes upstream Hermes via a cheap GET (caught,
  // never propagates failure) so it's safe to scrape.
  app.get(
    "/health/detailed",
    { preHandler: deps.requireAuth },
    async () => {
      const launcher = deps.launcher;
      const hermesMode = launcher ? launcher.getMode() : "unknown";

      let upstreamReachable = false;
      let lastUpstreamError: string | null = null;
      if (deps.hermesHttp) {
        try {
          await deps.hermesHttp.modelInfo();
          upstreamReachable = true;
        } catch (err) {
          lastUpstreamError =
            err instanceof Error ? err.message : String(err);
        }
      }

      const wsConnected = deps.wsPool
        ? deps.wsPool.getOrCreateShared().isOpen()
        : false;

      return {
        status: "ok",
        uptimeS: Math.floor(process.uptime()),
        hermes: {
          mode: hermesMode,
          upstreamReachable,
          lastError: lastUpstreamError,
        },
        ws: {
          // Active client count is owned by the WS layer; we report only the
          // shared upstream link here. Per-client counters could be added
          // later via a registry inside gateway-ws.ts.
          upstreamConnected: wsConnected,
        },
        cleanup: deps.cleanup ? deps.cleanup.getStatus() : {},
        watcher: deps.cronWatcherStatus
          ? deps.cronWatcherStatus()
          : { enabled: false, running: false },
      };
    },
  );
}
