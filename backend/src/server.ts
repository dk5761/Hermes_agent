import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import type { AppConfig } from "./config.js";
import type { AppLogger } from "./logger.js";
import type { DbHandle } from "./db/client.js";
import type { BlobStore } from "./storage/blob-store.js";
import { SignedUrlSigner } from "./storage/signed-url.js";
import { makeRequireAuth } from "./auth/middleware.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerSessionsRoutes } from "./routes/sessions.js";
import { registerCronRoutes } from "./routes/cron.js";
import { registerCronPrefsRoutes } from "./routes/cron-prefs.js";
import { registerDevicesRoutes } from "./routes/devices.js";
import { registerProxyRoutes } from "./routes/proxy.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerUploadsRoutes } from "./routes/uploads.js";
import { registerBlobsRoutes } from "./routes/blobs.js";
import { registerGatewayWsRoute } from "./ws/gateway-ws.js";
import { AttachmentBridge } from "./ws/attachment-bridge.js";
import type { ProcessLauncher } from "./hermes/launcher.js";
import type { HermesHttpClient } from "./hermes/http-client.js";
import type { HermesWsPool } from "./hermes/ws-pool.js";
import type { CleanupTasksHandle } from "./cleanup/runner.js";
import { ChatRunTimer } from "./observability/chat-run-timer.js";
import "./types/user.js";

export interface BuildServerDeps {
  config: AppConfig;
  logger: AppLogger;
  dbHandle: DbHandle;
  blobStore: BlobStore;
  launcher: ProcessLauncher;
  hermesHttp: HermesHttpClient;
  wsPool: HermesWsPool;
  // Phase 7: optional ops surfaces. Wired by index.ts; tests can pass undefined.
  cleanup?: CleanupTasksHandle;
  cronWatcherStatus?: () => { enabled: boolean; running: boolean };
  chatRunTimer?: ChatRunTimer;
}

export async function buildServer(deps: BuildServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: deps.logger.level,
      base: { service: "hermes-gateway" },
    },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  await app.register(websocket);
  await app.register(multipart, {
    limits: {
      // Per-route bodyLimit on /uploads overrides this; keeping here as a
      // safety upper bound for any other multipart consumer.
      fileSize: deps.config.UPLOAD_BODY_LIMIT_BYTES,
      files: 1,
      fields: 8,
    },
  });

  // Phase 7: register the rate-limit plugin once at the top level. Tighter
  // overrides are applied at /auth/login (IP-based, brute-force defense) and
  // /uploads (per-user, abuse defense). /health and /blobs/:id opt out via
  // their own route configs (frequent ops calls + signed-URL CDN-style
  // traffic respectively).
  await app.register(rateLimit, {
    global: true,
    max: deps.config.RATE_LIMIT_GLOBAL_MAX,
    timeWindow: deps.config.RATE_LIMIT_GLOBAL_WINDOW_MS,
    // Compose IP + user id when authenticated so two devices behind the same
    // NAT don't share a budget.
    keyGenerator: (req) => {
      const userId = req.user?.id;
      return userId ? `${req.ip}:${userId}` : req.ip;
    },
    // The plugin throws this object as an error. Including `statusCode` lets
    // Fastify's default 429 path through; our `setErrorHandler` also reads
    // `statusCode` to pass it along instead of collapsing to 500.
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: ctx.statusCode,
      error: "rate_limited",
      retryAfterMs: ctx.ttl,
    }),
  });

  const signer = new SignedUrlSigner({ secret: deps.config.STORAGE_SIGNED_URL_SECRET });

  const jwtConfig = {
    secret: deps.config.JWT_SECRET,
    accessTtl: deps.config.ACCESS_TOKEN_TTL,
  };

  const requireAuth = makeRequireAuth({ db: deps.dbHandle.db, jwt: jwtConfig });

  app.setNotFoundHandler((_request, reply) => {
    void reply.code(404).send({ error: "not_found" });
  });

  app.setErrorHandler((err: unknown, request, reply) => {
    request.log.error({ err }, "request_error");
    const e = err as {
      statusCode?: number;
      message?: string;
      // Phase 7: rate-limit plugin throws a plain object payload rather than
      // an Error; pass that through verbatim instead of collapsing to 500.
      error?: string;
      retryAfterMs?: number;
    };
    const status = typeof e.statusCode === "number" ? e.statusCode : 500;
    if (status === 429 && typeof e.error === "string") {
      void reply.code(429).send({
        error: e.error,
        retryAfterMs: e.retryAfterMs,
      });
      return;
    }
    const message = typeof e.message === "string" ? e.message : "internal_error";
    void reply.code(status).send({
      error: status >= 500 ? "internal_error" : message,
    });
  });

  await registerHealthRoutes(app, {
    requireAuth,
    launcher: deps.launcher,
    hermesHttp: deps.hermesHttp,
    wsPool: deps.wsPool,
    ...(deps.cleanup ? { cleanup: deps.cleanup } : {}),
    ...(deps.cronWatcherStatus ? { cronWatcherStatus: deps.cronWatcherStatus } : {}),
  });
  await registerAuthRoutes(app, {
    db: deps.dbHandle.db,
    jwt: jwtConfig,
    refreshTtlDays: deps.config.REFRESH_TOKEN_TTL_DAYS,
    loginRateLimit: {
      max: deps.config.RATE_LIMIT_LOGIN_MAX,
      timeWindowMs: deps.config.RATE_LIMIT_LOGIN_WINDOW_MS,
    },
  });
  await registerSessionsRoutes(app, {
    db: deps.dbHandle.db,
    requireAuth,
    hermesHttp: deps.hermesHttp,
    logger: deps.logger,
  });
  await registerCronRoutes(app, {
    db: deps.dbHandle.db,
    requireAuth,
    hermesHttp: deps.hermesHttp,
    hermesHomeOverride: deps.config.HERMES_HOME,
  });
  await registerCronPrefsRoutes(app, {
    db: deps.dbHandle.db,
    requireAuth,
  });
  await registerDevicesRoutes(app, {
    db: deps.dbHandle.db,
    requireAuth,
  });
  await registerProxyRoutes(app, { requireAuth, hermesHttp: deps.hermesHttp });
  await registerSettingsRoutes(app, {
    requireAuth,
    hermesHttp: deps.hermesHttp,
    logger: deps.logger,
  });

  await registerUploadsRoutes(app, {
    db: deps.dbHandle.db,
    requireAuth,
    blobStore: deps.blobStore,
    signer,
    signedUrlTtlS: deps.config.STORAGE_SIGNED_URL_TTL_S,
    limits: {
      imageBytes: deps.config.UPLOAD_MAX_IMAGE_BYTES,
      pdfBytes: deps.config.UPLOAD_MAX_PDF_BYTES,
      otherBytes: deps.config.UPLOAD_MAX_OTHER_BYTES,
    },
    bodyLimitBytes: deps.config.UPLOAD_BODY_LIMIT_BYTES,
    bucket: deps.config.STORAGE_BUCKET,
    logger: deps.logger,
    uploadRateLimit: {
      max: deps.config.RATE_LIMIT_UPLOAD_MAX,
      timeWindowMs: deps.config.RATE_LIMIT_UPLOAD_WINDOW_MS,
    },
    ocr: {
      enabled: deps.config.OCR_ENABLED,
      pdftoppmBin: deps.config.OCR_PDFTOPPM_BIN,
      tesseractBin: deps.config.OCR_TESSERACT_BIN,
      maxPages: deps.config.OCR_MAX_PAGES,
      dpi: deps.config.OCR_DPI,
      timeoutMs: deps.config.OCR_TIMEOUT_MS,
      languages: deps.config.OCR_LANGUAGES,
    },
  });

  await registerBlobsRoutes(app, {
    db: deps.dbHandle.db,
    blobStore: deps.blobStore,
    signer,
    logger: deps.logger,
  });

  const attachmentBridge = new AttachmentBridge({
    db: deps.dbHandle.db,
    blobStore: deps.blobStore,
    logger: deps.logger,
    config: {
      perPdfBytes: deps.config.UPLOAD_PROMPT_PDF_PER_FILE_BYTES,
      totalPrefixBytes: deps.config.UPLOAD_PROMPT_PDF_TOTAL_BYTES,
    },
  });

  await registerGatewayWsRoute(app, {
    db: deps.dbHandle.db,
    jwt: jwtConfig,
    logger: deps.logger,
    wsPool: deps.wsPool,
    attachmentBridge,
    ...(deps.chatRunTimer ? { chatRunTimer: deps.chatRunTimer } : {}),
  });

  return app;
}
