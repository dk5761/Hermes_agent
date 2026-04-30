// Cleanup task scheduler.
//
// Owns intervals for each Phase 7 sweeper. Tasks are independent — one
// failing doesn't block the others. Each task records its last run summary
// for /health/detailed observability.
//
// Lifecycle: start() schedules intervals (and runs each task once eagerly so
// ops can inspect results without waiting for the first interval); stop()
// clears intervals and awaits any in-flight task. SIGTERM handlers in
// index.ts call stop() before closing fastify.

import type { Db } from "../db/client.js";
import type { AppLogger } from "../logger.js";
import type { BlobStore } from "../storage/blob-store.js";
import { sweepMaterializeCache } from "./materialize-cache-sweeper.js";
import { sweepOrphanBlobs } from "./orphan-sweeper.js";
import { sweepPushTokens } from "./push-token-sweeper.js";
import { sweepRefreshTokens } from "./refresh-token-sweeper.js";

export interface CleanupResult {
  task: string;
  scanned: number;
  deleted: number;
  errors: number;
  durationMs: number;
  lastRunAt: number;
}

export interface CleanupTaskConfig {
  // Toggle to disable the entire scheduler (tests / boot diagnostics).
  enabled: boolean;
  orphanBlobAgeHours: number;
  refreshTokenGraceDays: number;
  pushTokenStaleDays: number;
  // Materialize cache prune is only meaningful in S3 mode; runner skips when
  // `materializeCacheDir` is null.
  materializeCacheDir: string | null;
  materializeCacheMaxAgeDays: number;
}

export interface CleanupTaskDeps {
  db: Db;
  logger: AppLogger;
  blobStore: BlobStore;
  config: CleanupTaskConfig;
}

export interface CleanupTasksHandle {
  stop: () => Promise<void>;
  // Snapshot of the most recent result per task. Empty until tasks have run.
  getStatus: () => Record<string, CleanupResult>;
}

interface ScheduledTask {
  name: string;
  intervalMs: number;
  run: () => Promise<CleanupResult>;
}

const ONE_HOUR_MS = 60 * 60 * 1000;
const SIX_HOURS_MS = 6 * ONE_HOUR_MS;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

export function startCleanupTasks(deps: CleanupTaskDeps): CleanupTasksHandle {
  const log = deps.logger.child({ component: "cleanup-runner" });

  if (!deps.config.enabled) {
    log.warn("cleanup tasks disabled via CLEANUP_ENABLED=false");
    return {
      stop: async () => undefined,
      getStatus: () => ({}),
    };
  }

  const lastResults: Record<string, CleanupResult> = {};
  const tasks: ScheduledTask[] = [
    {
      name: "orphan-blobs",
      intervalMs: SIX_HOURS_MS,
      run: () =>
        sweepOrphanBlobs(
          { db: deps.db, blobStore: deps.blobStore, logger: deps.logger },
          { ageHours: deps.config.orphanBlobAgeHours },
        ),
    },
    {
      name: "refresh-tokens",
      intervalMs: ONE_DAY_MS,
      run: () =>
        sweepRefreshTokens(
          { db: deps.db, logger: deps.logger },
          { graceDays: deps.config.refreshTokenGraceDays },
        ),
    },
    {
      name: "push-tokens",
      intervalMs: ONE_DAY_MS,
      run: () =>
        sweepPushTokens(
          { db: deps.db, logger: deps.logger },
          { staleDays: deps.config.pushTokenStaleDays },
        ),
    },
  ];

  if (deps.config.materializeCacheDir) {
    const cacheDir = deps.config.materializeCacheDir;
    tasks.push({
      name: "materialize-cache",
      intervalMs: SIX_HOURS_MS,
      run: () =>
        sweepMaterializeCache(deps.logger, {
          cacheDir,
          maxAgeDays: deps.config.materializeCacheMaxAgeDays,
        }),
    });
  }

  const timers = new Map<string, NodeJS.Timeout>();
  const inFlight = new Map<string, Promise<void>>();
  let stopped = false;

  const runTask = async (task: ScheduledTask): Promise<void> => {
    if (stopped) return;
    const existing = inFlight.get(task.name);
    if (existing) return existing;
    const work = (async () => {
      try {
        const result = await task.run();
        lastResults[task.name] = result;
      } catch (err) {
        log.error({ err, task: task.name }, "cleanup task crashed");
        lastResults[task.name] = {
          task: task.name,
          scanned: 0,
          deleted: 0,
          errors: 1,
          durationMs: 0,
          lastRunAt: Math.floor(Date.now() / 1000),
        };
      }
    })();
    inFlight.set(task.name, work);
    try {
      await work;
    } finally {
      inFlight.delete(task.name);
    }
  };

  for (const task of tasks) {
    const handle = setInterval(() => {
      void runTask(task);
    }, task.intervalMs);
    handle.unref();
    timers.set(task.name, handle);
    // Eager initial run so ops can see status without waiting for the interval.
    // We don't await here — startup must not block on sweep work.
    void runTask(task);
  }
  log.info({ tasks: tasks.map((t) => t.name) }, "cleanup tasks scheduled");

  return {
    stop: async () => {
      stopped = true;
      for (const handle of timers.values()) clearInterval(handle);
      timers.clear();
      // Bound the wait so SIGTERM doesn't hang on a slow sweep — sweeps are
      // idempotent so a half-completed run is fine to abandon.
      await Promise.race([
        Promise.allSettled(inFlight.values()),
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 1000);
          t.unref();
        }),
      ]);
    },
    getStatus: () => ({ ...lastResults }),
  };
}
