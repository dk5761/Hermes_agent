/**
 * Route-level integration test for the /cron/outputs endpoints.
 * Boots a Fastify instance, registers the cron routes with a stub auth
 * preHandler + a stub HermesHttpClient, points at a temp HERMES_HOME
 * populated with output files on disk, and uses `app.inject` to exercise
 * the routes the same way the mobile client would.
 *
 * Run with:
 *   pnpm exec tsx scripts/test-cron-routes.ts
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Fastify from "fastify";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";

import { registerCronRoutes } from "../src/routes/cron.js";
import type { HermesHttpClient } from "../src/hermes/http-client.js";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    console.error("✗ FAIL:", message);
    process.exit(1);
  }
  console.log("✓", message);
}

// Stub auth: attach a fake user, never reject. The cron routes only read
// `request.user`, so this is enough for shape-level testing.
const stubAuth: preHandlerHookHandler = async (request, _reply) => {
  // @ts-expect-error decorate user at runtime — gateway does this through
  // a Fastify decorator; for the test we shortcut.
  request.user = { id: "test-user", email: "test@test" };
};

// Stub Hermes client. Only the routes we exercise pull from this; cron
// outputs are FS-only, so for the by-job + outputs paths no upstream call
// fires. Other handlers (list/get jobs) would call these — we leave them
// as throwers to confirm the test paths are FS-only.
const stubHermes: HermesHttpClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async listCronJobs() { throw new Error("listCronJobs should not be called in this test"); },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getCronJob() { throw new Error("getCronJob should not be called"); },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async createCronJob() { throw new Error("not used"); },
  async updateCronJob() { throw new Error("not used"); },
  async cronJobAction() { throw new Error("not used"); },
  async deleteCronJob() { throw new Error("not used"); },
  // The HermesHttpClient interface has more methods unrelated to this test;
  // we cast through unknown to keep this stub minimal.
} as unknown as HermesHttpClient;

async function buildFixtureHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cron-routes-test-"));

  const fixtures = [
    {
      jobId: "job-a",
      outputId: "2026-05-01_09-00-00",
      content: "# Run May 1\n\nFirst standup line.\nSecond line.\n",
      mtimeMs: new Date("2026-05-01T09:00:00Z").getTime(),
    },
    {
      jobId: "job-a",
      outputId: "2026-05-08_09-00-00",
      content: "# Run May 8\n\n- Latest run alpha line.\n",
      mtimeMs: new Date("2026-05-08T09:00:00Z").getTime(),
    },
    {
      jobId: "job-b",
      outputId: "2026-05-07_18-00-00",
      content: "Cost rollup line one.\nLine two body.\n",
      mtimeMs: new Date("2026-05-07T18:00:00Z").getTime(),
    },
  ];

  for (const fx of fixtures) {
    const dir = path.join(home, "cron", "output", fx.jobId);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${fx.outputId}.md`);
    await fs.writeFile(file, fx.content, "utf8");
    await fs.utimes(file, fx.mtimeMs / 1000, fx.mtimeMs / 1000);
  }
  // Empty job dir — should be excluded from by-job listing.
  await fs.mkdir(path.join(home, "cron", "output", "job-empty"), { recursive: true });

  return home;
}

async function buildApp(home: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // In-memory SQLite for the augmentation queries (notify flags). Empty
  // table is fine — augmentation defaults notifyOnComplete to false.
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE cron_prefs (
      user_id TEXT NOT NULL,
      hermes_job_id TEXT NOT NULL,
      notify_on_complete INTEGER NOT NULL DEFAULT 0,
      last_seen_output_id TEXT,
      updated_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, hermes_job_id)
    );
  `);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sqlite) as any;

  await registerCronRoutes(app, {
    db,
    requireAuth: stubAuth,
    hermesHttp: stubHermes,
    hermesHomeOverride: home,
  });
  return app;
}

interface ByJobResponse {
  items: Array<{
    jobId: string;
    count: number;
    latest: { id: string; createdAt: string; preview: string };
  }>;
}

interface OutputsResponse {
  outputs: Array<{
    id: string;
    jobId: string;
    createdAt: string;
    sizeBytes: number;
    preview: string;
  }>;
}

interface OutputDetail {
  id: string;
  jobId: string;
  createdAt: string;
  sizeBytes: number;
  preview: string;
  content: string;
}

async function main(): Promise<void> {
  const home = await buildFixtureHome();
  const app = await buildApp(home);

  // GET /cron/outputs/by-job ───────────────────────────────────────────
  const byJob = await app.inject({
    method: "GET",
    url: "/cron/outputs/by-job",
    headers: { authorization: "Bearer ignored-by-stub" },
  });
  assert(byJob.statusCode === 200, `/cron/outputs/by-job → 200 (got ${byJob.statusCode})`);
  const byJobBody = JSON.parse(byJob.body) as ByJobResponse;
  assert(Array.isArray(byJobBody.items), "/cron/outputs/by-job returns { items: [] } shape");
  assert(byJobBody.items.length === 2, `/cron/outputs/by-job excludes empty dirs (got ${byJobBody.items.length} items)`);
  assert(byJobBody.items[0]?.jobId === "job-a", "/cron/outputs/by-job sorts newest-first (job-a, May 8)");
  assert(byJobBody.items[0]?.count === 2, "/cron/outputs/by-job count includes all files in dir");
  assert((byJobBody.items[0]?.latest.preview.length ?? 0) > 0, "/cron/outputs/by-job latest.preview is populated");
  assert(byJobBody.items[1]?.jobId === "job-b", "/cron/outputs/by-job second item is job-b");

  // GET /cron/outputs?job_id=job-a ─────────────────────────────────────
  const list = await app.inject({
    method: "GET",
    url: "/cron/outputs?job_id=job-a",
    headers: { authorization: "Bearer ignored" },
  });
  assert(list.statusCode === 200, `/cron/outputs?job_id=job-a → 200 (got ${list.statusCode})`);
  const listBody = JSON.parse(list.body) as OutputsResponse;
  assert(listBody.outputs.length === 2, `/cron/outputs returns 2 entries (got ${listBody.outputs.length})`);
  assert(listBody.outputs[0]?.id === "2026-05-08_09-00-00", "/cron/outputs sorts newest-first");
  assert(typeof listBody.outputs[0]?.preview === "string" && listBody.outputs[0]!.preview.length > 0, "/cron/outputs entries include preview");

  // Bad query ──────────────────────────────────────────────────────────
  const bad = await app.inject({
    method: "GET",
    url: "/cron/outputs",
    headers: { authorization: "Bearer x" },
  });
  assert(bad.statusCode === 400, `/cron/outputs without job_id → 400 (got ${bad.statusCode})`);

  // GET /cron/outputs/:id ──────────────────────────────────────────────
  const detail = await app.inject({
    method: "GET",
    url: "/cron/outputs/2026-05-08_09-00-00?job_id=job-a",
    headers: { authorization: "Bearer x" },
  });
  assert(detail.statusCode === 200, `/cron/outputs/:id → 200 (got ${detail.statusCode})`);
  const detailBody = JSON.parse(detail.body) as OutputDetail;
  assert(detailBody.content.includes("Run May 8"), "/cron/outputs/:id returns full markdown content");
  assert(detailBody.preview.length > 0, "/cron/outputs/:id includes preview");

  const notFound = await app.inject({
    method: "GET",
    url: "/cron/outputs/no-such-id?job_id=job-a",
    headers: { authorization: "Bearer x" },
  });
  assert(notFound.statusCode === 404, `/cron/outputs/:id missing → 404 (got ${notFound.statusCode})`);

  await app.close();
  await fs.rm(home, { recursive: true, force: true });
  console.log("\nAll route checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
