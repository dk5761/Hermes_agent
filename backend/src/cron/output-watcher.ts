// Cron output watcher.
//
// Watches `${HERMES_HOME}/cron/output/{job_id}/*.md` recursively. On a new
// markdown file, fan out an Expo push to every subscribed user and bump
// their cron_prefs.last_seen_output_id atomically with any stale-token
// cleanup.
//
// Bootstrap strategy:
//   - On startup, BEFORE chokidar attaches, we scan every subscriber's
//     watched job directory and set last_seen_output_id to the lexicographically
//     greatest existing output. This prevents the watcher from spamming the
//     entire backlog of historical outputs as `add` events on first boot.
//   - Trade-off: a file added between the bootstrap snapshot and chokidar's
//     subscribe may be missed. For a personal-use cron we accept this race;
//     the alternative (snapshot-then-diff loop) is more code than warranted.
//
// Output IDs are filename basenames sorted lexicographically. Hermes names
// outputs with ISO-ish timestamps so lexical sort == chronological sort.

import path from "node:path";
import fs from "node:fs/promises";
import chokidar, { type FSWatcher } from "chokidar";
import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { cronPrefs, pushTokens } from "../db/schema.js";
import type { AppLogger } from "../logger.js";
import type { HermesHttpClient } from "../hermes/http-client.js";
import { readCronOutput } from "../hermes/cron-fs.js";
import { findSubscribersForJob } from "./subscriber-lookup.js";
import { buildNotificationFor, type JobMeta } from "./notify.js";
import { maybeRouteCronOutput } from "./route-to-session.js";
import type { ExpoClient } from "../push/expo-client.js";
import type { PushPayload } from "../push/types.js";
import type { SubscriberRegistry } from "../ws/subscriber-registry.js";
import type { ChatCompleteNotifier } from "../push/chat-complete.js";

export interface CronOutputWatcherDeps {
  db: Db;
  logger: AppLogger;
  hermesHome: string;
  hermesHttp: HermesHttpClient;
  expo: ExpoClient;
  pollIntervalMs: number;
  /**
   * Shared WS subscriber registry. When the cron has a binding to an
   * app_session, we emit live envelopes through this registry so an open
   * chat screen for that session updates without reload. Optional —
   * routing still persists rows correctly without it.
   */
  registry?: SubscriberRegistry;
  /**
   * Push notifier reused from gateway-ws. When a binding has notifyOnRun=true
   * and the user has notifyChatComplete enabled, fires an Expo push on each
   * cron run that lands in the bound session.
   */
  chatCompleteNotifier?: ChatCompleteNotifier;
}

interface CachedJobMeta {
  meta: JobMeta;
  expiresAt: number;
}

const JOB_NAME_CACHE_TTL_MS = 30_000;

export class CronOutputWatcher {
  private readonly db: Db;
  private readonly log: AppLogger;
  private readonly hermesHome: string;
  private readonly hermesHttp: HermesHttpClient;
  private readonly expo: ExpoClient;
  private readonly pollIntervalMs: number;
  private readonly registry: SubscriberRegistry | undefined;
  private readonly chatCompleteNotifier: ChatCompleteNotifier | undefined;
  private watcher: FSWatcher | null = null;
  private readonly jobMetaCache = new Map<string, CachedJobMeta>();
  // Serialize per-job processing so two concurrent `add` events for the same
  // job don't race on last_seen_output_id updates.
  private readonly jobLocks = new Map<string, Promise<void>>();

  constructor(deps: CronOutputWatcherDeps) {
    this.db = deps.db;
    this.log = deps.logger.child({ component: "cron-watcher" });
    this.hermesHome = deps.hermesHome;
    this.hermesHttp = deps.hermesHttp;
    this.expo = deps.expo;
    this.pollIntervalMs = deps.pollIntervalMs;
    this.registry = deps.registry;
    this.chatCompleteNotifier = deps.chatCompleteNotifier;
  }

  async start(): Promise<void> {
    if (this.watcher) return;
    const dir = path.join(this.hermesHome, "cron", "output");
    await fs.mkdir(dir, { recursive: true });

    // Bootstrap: snapshot the current FS state into last_seen_output_id so we
    // don't fire pushes for backlog. Runs synchronously before chokidar starts.
    await this.bootstrapLastSeen(dir);

    this.watcher = chokidar.watch(dir, {
      ignoreInitial: true,
      // awaitWriteFinish: avoid firing while Hermes is still appending to the
      // file. 500ms stability window matches Hermes's typical write cadence.
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: this.pollIntervalMs,
      },
      depth: 2,
      // Docker Desktop on macOS uses VirtioFS bind mounts whose inotify
      // events from host-side writes don't reliably reach the container.
      // Enable polling fallback when CHOKIDAR_USEPOLLING is set (already
      // wired into docker-compose.yml for the gateway service). Native
      // inotify is preferred on Linux/VPS where it's reliable.
      usePolling: process.env["CHOKIDAR_USEPOLLING"] === "true",
      interval: this.pollIntervalMs,
    });

    this.watcher.on("add", (filePath) => {
      void this.handleAdd(filePath, dir).catch((err) => {
        this.log.error({ err, filePath }, "watcher handler crashed");
      });
    });
    this.watcher.on("error", (err) => {
      this.log.error({ err }, "chokidar error");
    });

    this.log.info({ dir }, "cron output watcher started");
  }

  async stop(): Promise<void> {
    if (!this.watcher) return;
    const w = this.watcher;
    this.watcher = null;
    try {
      await w.close();
    } catch (err) {
      this.log.error({ err }, "error closing watcher");
    }
    // Wait for any in-flight per-job handlers to finish so callers can rely
    // on stop() meaning "no more DB writes from this watcher".
    await Promise.allSettled(this.jobLocks.values());
    this.log.info("cron output watcher stopped");
  }

  private async bootstrapLastSeen(rootDir: string): Promise<void> {
    // For each (user_id, hermes_job_id) row that has notify_on_complete=1,
    // update last_seen_output_id to the greatest existing output id. This is
    // a best-effort startup operation — failures are logged, not thrown.
    const rows = await this.db
      .select({
        id: cronPrefs.id,
        hermesJobId: cronPrefs.hermesJobId,
        lastSeenOutputId: cronPrefs.lastSeenOutputId,
      })
      .from(cronPrefs)
      .where(eq(cronPrefs.notifyOnComplete, 1));

    // Cache greatest-output-id per job so we don't re-readdir for every user.
    const greatestByJob = new Map<string, string | null>();
    for (const row of rows) {
      let greatest = greatestByJob.get(row.hermesJobId);
      if (greatest === undefined) {
        greatest = await this.computeGreatestOutputId(rootDir, row.hermesJobId);
        greatestByJob.set(row.hermesJobId, greatest);
      }
      if (greatest === null) continue;
      // Only advance — never rewind a user's pointer if they've already seen
      // newer outputs from a previous boot.
      if (row.lastSeenOutputId !== null && row.lastSeenOutputId >= greatest) continue;
      const now = Math.floor(Date.now() / 1000);
      await this.db
        .update(cronPrefs)
        .set({ lastSeenOutputId: greatest, updatedAt: now })
        .where(eq(cronPrefs.id, row.id));
    }
    if (rows.length > 0) {
      this.log.info(
        { subscriptions: rows.length, jobs: greatestByJob.size },
        "bootstrap last_seen_output_id complete",
      );
    }
  }

  private async computeGreatestOutputId(
    rootDir: string,
    jobId: string,
  ): Promise<string | null> {
    const dir = path.join(rootDir, jobId);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return null;
      this.log.warn({ err, jobId }, "bootstrap readdir failed");
      return null;
    }
    let greatest: string | null = null;
    for (const name of entries) {
      if (!name.endsWith(".md")) continue;
      const id = name.slice(0, -3);
      if (greatest === null || id > greatest) greatest = id;
    }
    return greatest;
  }

  private async handleAdd(filePath: string, rootDir: string): Promise<void> {
    const rel = path.relative(rootDir, filePath);
    // Expected layout: `${jobId}/${outputId}.md`. Anything else we ignore.
    const parts = rel.split(path.sep);
    if (parts.length !== 2) return;
    const [jobId, fileName] = parts;
    if (!jobId || !fileName || !fileName.endsWith(".md")) return;
    const outputId = fileName.slice(0, -3);

    // Per-job mutex to avoid interleaving last_seen updates.
    const prev = this.jobLocks.get(jobId) ?? Promise.resolve();
    const next = prev.then(() => this.processOutput(jobId, outputId));
    this.jobLocks.set(
      jobId,
      next.finally(() => {
        // Only clear if we're still the head — otherwise a later enqueue owns it.
        if (this.jobLocks.get(jobId) === next) this.jobLocks.delete(jobId);
      }),
    );
    await next;
  }

  private async processOutput(jobId: string, outputId: string): Promise<void> {
    // Cron-inbox dispatch: if this job has a binding, route its output into
    // the bound app_session's chat history INSTEAD of fanning out the legacy
    // markdown push. The session-bound rendering covers both the visible
    // chat update and (via chat-complete-notifier on the assistant.message
    // we synthesise) the push-notification UX.
    const out = await readCronOutput(this.hermesHome, jobId, outputId);
    if (!out) {
      this.log.warn({ jobId, outputId }, "output disappeared before processing");
      return;
    }
    const job = await this.getJobMeta(jobId);

    const routed = await maybeRouteCronOutput({
      db: this.db,
      cronJobId: jobId,
      outputId,
      content: out.content,
      ...(job.name ? { cronName: job.name } : {}),
      ...(this.registry ? { registry: this.registry } : {}),
      ...(this.chatCompleteNotifier
        ? { chatCompleteNotifier: this.chatCompleteNotifier }
        : {}),
      log: this.log,
    });
    if (routed) {
      // Routed into a session — skip the legacy push fan-out. Advance
      // last_seen pointers for any subscribed cron_prefs rows so a later
      // unbinding doesn't replay this output as a fresh push.
      const subs = await findSubscribersForJob(this.db, jobId);
      const prefIds = subs
        .filter((s) => s.lastSeenOutputId === null || outputId > s.lastSeenOutputId)
        .map((s) => s.prefId);
      if (prefIds.length > 0) {
        const now = Math.floor(Date.now() / 1000);
        this.db.transaction((tx) => {
          tx.update(cronPrefs)
            .set({ lastSeenOutputId: outputId, updatedAt: now })
            .where(inArray(cronPrefs.id, prefIds))
            .run();
        });
      }
      return;
    }

    // No binding — legacy markdown push fan-out path.
    const subs = await findSubscribersForJob(this.db, jobId);
    if (subs.length === 0) return;

    // Skip subs that have already seen this output (idempotent re-fires).
    const eligible = subs.filter(
      (s) => s.lastSeenOutputId === null || outputId > s.lastSeenOutputId,
    );
    if (eligible.length === 0) return;

    const payloads: PushPayload[] = [];
    for (const sub of eligible) {
      for (const token of sub.expoTokens) {
        payloads.push(
          buildNotificationFor(token, job, {
            outputId,
            contentPreview: out.content,
          }),
        );
      }
    }

    let staleTokens: string[] = [];
    if (payloads.length > 0) {
      const result = await this.expo.sendMany(payloads);
      staleTokens = result.staleTokens;
      this.log.info(
        {
          jobId,
          outputId,
          eligible: eligible.length,
          ok: result.okCount,
          err: result.errorCount,
          stale: staleTokens.length,
        },
        "cron push fanout",
      );
    }

    // Atomically update last_seen pointers + prune stale tokens. We use a
    // single transaction so a crash mid-way doesn't leave us double-firing
    // for the same output.
    const prefIds = eligible.map((e) => e.prefId);
    const now = Math.floor(Date.now() / 1000);
    this.db.transaction((tx) => {
      if (prefIds.length > 0) {
        tx.update(cronPrefs)
          .set({ lastSeenOutputId: outputId, updatedAt: now })
          .where(inArray(cronPrefs.id, prefIds))
          .run();
      }
      if (staleTokens.length > 0) {
        tx.delete(pushTokens)
          .where(inArray(pushTokens.expoToken, staleTokens))
          .run();
      }
    });
    // Avoid unused-import warning for sql when no other use exists.
    void sql;
  }

  private async getJobMeta(jobId: string): Promise<JobMeta> {
    const cached = this.jobMetaCache.get(jobId);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.meta;

    let name: string | null = null;
    try {
      const raw = (await this.hermesHttp.getCronJob(jobId)) as Record<string, unknown>;
      const candidate = raw["name"] ?? raw["title"];
      if (typeof candidate === "string" && candidate.length > 0) name = candidate;
    } catch (err) {
      // Upstream Hermes may be down or restarting. Don't fail the push;
      // fall back to the generic title and skip the cache so we retry next time.
      this.log.debug({ err, jobId }, "job meta fetch failed; using fallback");
      return { jobId, name: null };
    }
    const meta: JobMeta = { jobId, name };
    this.jobMetaCache.set(jobId, { meta, expiresAt: now + JOB_NAME_CACHE_TTL_MS });
    return meta;
  }
}
