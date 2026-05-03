import { loadConfig } from "./config.js";
import { buildLogger } from "./logger.js";
import { openDb, runMigrations } from "./db/client.js";
import { buildBlobStore } from "./storage/factory.js";
import { buildServer } from "./server.js";
import { bootstrapSingleUserIfEmpty } from "./auth/bootstrap.js";
import { ProcessLauncher } from "./hermes/launcher.js";
import { HermesHttpClient } from "./hermes/http-client.js";
import { HermesWsPool } from "./hermes/ws-pool.js";
import { startEventLogSweeper } from "./ws/event-log.js";
import { ExpoClient } from "./push/expo-client.js";
import { CronOutputWatcher } from "./cron/output-watcher.js";
import { resolveHermesHome } from "./hermes/cron-fs.js";
import { startCleanupTasks } from "./cleanup/runner.js";
import { ChatRunTimer } from "./observability/chat-run-timer.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = buildLogger(config);
  const dbHandle = openDb(config.DATABASE_URL);

  // Apply pending migrations on every boot. drizzle's migrator is idempotent
  // — it tracks applied versions in __drizzle_migrations. This makes
  // `pnpm db:migrate` redundant in Docker (still in the CMD as a belt-and-
  // braces) and removes the manual step for host-mode dev.
  try {
    runMigrations(dbHandle.db);
    logger.info("db migrations up to date");
  } catch (err) {
    logger.error({ err }, "db migrations failed");
    throw err;
  }

  await bootstrapSingleUserIfEmpty({
    db: dbHandle.db,
    logger,
    username: config.BOOTSTRAP_USERNAME,
    password: config.BOOTSTRAP_PASSWORD,
  });

  const blobStore = buildBlobStore({ config, logger });

  const launcher = new ProcessLauncher({ config, logger });
  const hermesHttp = new HermesHttpClient({
    launcher,
    logger,
    requestTimeoutMs: config.HERMES_REQUEST_TIMEOUT_MS,
  });
  const wsPool = new HermesWsPool({
    launcher,
    logger,
    requestTimeoutMs: config.HERMES_REQUEST_TIMEOUT_MS,
  });

  // In spawn mode, eagerly start so first requests don't pay scrape latency.
  // In external mode `start()` is cheap (just reads env), no harm running it.
  try {
    await launcher.start();
  } catch (err) {
    logger.error({ err }, "launcher start failed; gateway will keep running and retry");
  }

  const sweeper = startEventLogSweeper(dbHandle.db, logger, {
    retentionHours: config.WS_EVENT_RETENTION_HOURS,
    postRunGraceHours: config.WS_EVENT_POSTRUN_GRACE_HOURS,
    keepLastPerSession: 200,
  });

  // Phase 7: cleanup sweepers + chat-run timer. Cleanup runs even when
  // CRON_OUTPUT_WATCH_ENABLED is false (separate concerns).
  const cleanup = startCleanupTasks({
    db: dbHandle.db,
    logger,
    blobStore,
    config: {
      enabled: config.CLEANUP_ENABLED,
      orphanBlobAgeHours: config.CLEANUP_ORPHAN_BLOB_AGE_HOURS,
      refreshTokenGraceDays: config.CLEANUP_REFRESH_TOKEN_GRACE_DAYS,
      pushTokenStaleDays: config.CLEANUP_PUSH_TOKEN_STALE_DAYS,
      // Cache prune is a no-op outside S3 mode; runner skips when null.
      materializeCacheDir:
        config.STORAGE_PROVIDER === "s3" ? config.STORAGE_S3_CACHE_DIR : null,
      materializeCacheMaxAgeDays: config.MATERIALIZE_CACHE_MAX_AGE_DAYS,
    },
  });
  const chatRunTimer = new ChatRunTimer(logger);

  // Phase 6: cron output watcher + Expo push client. Watcher start is deferred
  // until after the gateway is listening so any startup errors there don't
  // prevent REST routes (push token registration) from coming up.
  const expoClient = new ExpoClient({
    accessToken: config.EXPO_ACCESS_TOKEN,
    logger,
  });
  const cronWatcher = new CronOutputWatcher({
    db: dbHandle.db,
    logger,
    hermesHome: resolveHermesHome(config.HERMES_HOME),
    hermesHttp,
    expo: expoClient,
    pollIntervalMs: config.CRON_WATCH_POLL_MS,
  });

  // Track cron watcher lifecycle for /health/detailed.
  let cronWatcherRunning = false;

  const app = await buildServer({
    config,
    logger,
    dbHandle,
    blobStore,
    launcher,
    hermesHttp,
    wsPool,
    cleanup,
    cronWatcherStatus: () => ({
      enabled: config.CRON_OUTPUT_WATCH_ENABLED,
      running: cronWatcherRunning,
    }),
    chatRunTimer,
    expoClient,
  });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    try {
      sweeper.stop();
    } catch (err) {
      logger.error({ err }, "error stopping sweeper");
    }
    try {
      await cleanup.stop();
    } catch (err) {
      logger.error({ err }, "error stopping cleanup tasks");
    }
    try {
      chatRunTimer.stop();
    } catch (err) {
      logger.error({ err }, "error stopping chat run timer");
    }
    try {
      await cronWatcher.stop();
    } catch (err) {
      logger.error({ err }, "error stopping cron watcher");
    }
    try {
      await app.close();
    } catch (err) {
      logger.error({ err }, "error closing fastify");
    }
    try {
      await wsPool.close();
    } catch (err) {
      logger.error({ err }, "error closing ws pool");
    }
    try {
      await launcher.stop();
    } catch (err) {
      logger.error({ err }, "error stopping launcher");
    }
    try {
      dbHandle.close();
    } catch (err) {
      logger.error({ err }, "error closing db");
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.HOST, port: config.PORT });
  logger.info({ host: config.HOST, port: config.PORT }, "gateway listening");

  if (config.CRON_OUTPUT_WATCH_ENABLED) {
    try {
      await cronWatcher.start();
      cronWatcherRunning = true;
    } catch (err) {
      logger.error({ err }, "cron watcher failed to start; gateway continues");
    }
  } else {
    logger.info("cron output watcher disabled via CRON_OUTPUT_WATCH_ENABLED=false");
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("fatal:", err);
  process.exit(1);
});
