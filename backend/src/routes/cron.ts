import { and, eq } from "drizzle-orm";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { cronPrefs } from "../db/schema.js";
import type { HermesHttpClient } from "../hermes/http-client.js";
import {
  listAllJobsOutputSummary,
  listCronOutputs,
  readCronOutput,
  resolveHermesHome,
} from "../hermes/cron-fs.js";

export interface CronRoutesDeps {
  db: Db;
  requireAuth: preHandlerHookHandler;
  hermesHttp: HermesHttpClient;
  hermesHomeOverride: string | undefined;
}

const idParams = z.object({ id: z.string().min(1) });
const outputParams = z.object({ output_id: z.string().min(1) });
const outputsQuery = z.object({ job_id: z.string().min(1) });
const triggerParams = z.object({
  id: z.string().min(1),
  action: z.enum(["pause", "resume", "trigger"]),
});

export async function registerCronRoutes(app: FastifyInstance, deps: CronRoutesDeps): Promise<void> {
  const { db, requireAuth, hermesHttp } = deps;
  const hermesHome = resolveHermesHome(deps.hermesHomeOverride);

  app.get("/cron/jobs", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: "unauthenticated" });
    const upstream = await hermesHttp.listCronJobs();
    return reply.send(await augmentJobsList(db, user.id, upstream));
  });

  app.get("/cron/jobs/:id", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: "unauthenticated" });
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_params" });
    const upstream = await hermesHttp.getCronJob(params.data.id);
    return reply.send(await augmentSingleJob(db, user.id, params.data.id, upstream));
  });

  app.post("/cron/jobs", { preHandler: requireAuth }, async (request, reply) => {
    return reply.send(await hermesHttp.createCronJob(request.body ?? {}));
  });

  app.patch("/cron/jobs/:id", { preHandler: requireAuth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_params" });
    // Hermes uses PUT for the same logical update; our API exposes PATCH.
    return reply.send(await hermesHttp.updateCronJob(params.data.id, request.body ?? {}));
  });

  app.post("/cron/jobs/:id/:action", { preHandler: requireAuth }, async (request, reply) => {
    const params = triggerParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_params" });
    return reply.send(
      await hermesHttp.cronJobAction(params.data.id, params.data.action),
    );
  });

  app.delete("/cron/jobs/:id", { preHandler: requireAuth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_params" });
    await hermesHttp.deleteCronJob(params.data.id);
    return reply.send({ id: params.data.id, deleted: true });
  });

  // Cron outputs are FS-only — Hermes does not expose them via HTTP (per contract).
  app.get("/cron/outputs", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = outputsQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query" });
    const outputs = await listCronOutputs(hermesHome, parsed.data.job_id);
    return reply.send({ outputs });
  });

  // Aggregated "one row per job" list for the mobile Outputs tab. Returns
  // every job that has at least one output on disk, including outputs from
  // jobs that have since been deleted (the directory survives). Frontend
  // joins by jobId against /cron/jobs and surfaces an "archived" affordance
  // for unmatched ids.
  app.get("/cron/outputs/by-job", { preHandler: requireAuth }, async (_request, reply) => {
    const items = await listAllJobsOutputSummary(hermesHome);
    return reply.send({ items });
  });

  app.get("/cron/outputs/:output_id", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = outputParams.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_params" });
    const jobQuery = outputsQuery.safeParse(request.query);
    if (!jobQuery.success) return reply.code(400).send({ error: "invalid_query" });
    const out = await readCronOutput(hermesHome, jobQuery.data.job_id, parsed.data.output_id);
    if (!out) return reply.code(404).send({ error: "not_found" });
    return reply.send(out);
  });
}

// Phase 6: enrich upstream cron payloads with the requesting user's
// notifyOnComplete flag. Defaults to false when there's no row.
//
// Hermes' upstream sometimes returns a bare array `[...]` and sometimes
// `{jobs: [...]}` depending on version. We always emit `{jobs: [...]}` to
// match the frontend's typed contract — without this normalization the
// list view shows "no jobs yet" even when jobs exist.
async function augmentJobsList(db: Db, userId: string, upstream: unknown): Promise<unknown> {
  let jobs: unknown[] | null = null;
  let extras: Record<string, unknown> = {};
  if (Array.isArray(upstream)) {
    jobs = upstream;
  } else if (upstream && typeof upstream === "object") {
    const obj = upstream as Record<string, unknown>;
    if (Array.isArray(obj["jobs"])) {
      jobs = obj["jobs"] as unknown[];
      extras = obj;
    }
  }
  if (jobs === null) {
    // Unknown shape — wrap in {jobs: []} so frontend never crashes.
    return { jobs: [] };
  }
  const ids: string[] = [];
  for (const j of jobs) {
    if (j && typeof j === "object") {
      const id = (j as Record<string, unknown>)["id"];
      if (typeof id === "string") ids.push(id);
    }
  }
  const flagsByJob = await loadNotifyFlags(db, userId, ids);
  const augmented = jobs.map((j) => {
    if (!j || typeof j !== "object") return j;
    const id = (j as Record<string, unknown>)["id"];
    const notify = typeof id === "string" ? flagsByJob.get(id) === true : false;
    return { ...(j as Record<string, unknown>), notifyOnComplete: notify };
  });
  return { ...extras, jobs: augmented };
}

async function augmentSingleJob(
  db: Db,
  userId: string,
  jobId: string,
  upstream: unknown,
): Promise<unknown> {
  const flagsByJob = await loadNotifyFlags(db, userId, [jobId]);
  const notify = flagsByJob.get(jobId) === true;
  if (upstream && typeof upstream === "object") {
    return { ...(upstream as Record<string, unknown>), notifyOnComplete: notify };
  }
  return { notifyOnComplete: notify, raw: upstream };
}

async function loadNotifyFlags(
  db: Db,
  userId: string,
  jobIds: ReadonlyArray<string>,
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  if (jobIds.length === 0) return result;
  // Drizzle's inArray is the natural fit, but we want to avoid an extra
  // import for a single use. With single-user MVP and small N, looping is fine.
  for (const id of jobIds) {
    if (result.has(id)) continue;
    const rows = await db
      .select({ flag: cronPrefs.notifyOnComplete })
      .from(cronPrefs)
      .where(and(eq(cronPrefs.userId, userId), eq(cronPrefs.hermesJobId, id)))
      .limit(1);
    const row = rows[0];
    result.set(id, row !== undefined && row.flag === 1);
  }
  return result;
}
