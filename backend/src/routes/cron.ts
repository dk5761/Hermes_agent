import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { appSessions, cronJobBindings, cronPrefs } from "../db/schema.js";
import type { HermesHttpClient } from "../hermes/http-client.js";
import {
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
    // The binding row + cron_inbox app_session cascade-delete via FK
    // (cron_job_bindings.app_session_id → app_sessions.id ON DELETE CASCADE)
    // when the inbox session is dropped. We drop the binding here to also
    // clean up bindings whose target was a current_session (where the inbox
    // wasn't created and the user-chat itself stays around).
    const user = request.user;
    if (user) {
      const bindingRows = await db
        .select({
          appSessionId: cronJobBindings.appSessionId,
          outputKind: cronJobBindings.outputKind,
        })
        .from(cronJobBindings)
        .where(
          and(
            eq(cronJobBindings.cronJobId, params.data.id),
            eq(cronJobBindings.userId, user.id),
          ),
        )
        .limit(1);
      const binding = bindingRows[0];
      if (binding) {
        if (binding.outputKind === "inbox") {
          // Cascade-delete the synthetic inbox session — there's no chat
          // history worth retaining once the cron is gone.
          await db.delete(appSessions).where(eq(appSessions.id, binding.appSessionId));
        } else {
          // current_session bindings: just drop the binding row, leave the
          // user chat alone. Past cron-run rows in chat_history stand on
          // their own as messages.
          await db
            .delete(cronJobBindings)
            .where(eq(cronJobBindings.cronJobId, params.data.id));
        }
      }
    }
    return reply.send({ id: params.data.id, deleted: true });
  });

  // List all cron inbox sessions for the current user, joined with their
  // bindings so the Cron tab can show "name + schedule + output destination"
  // without an extra round-trip per row. Results are sorted newest-first by
  // app_session.updatedAt — recent activity bubbles up.
  app.get("/cron/inboxes", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: "unauthenticated" });
    const rows = await db
      .select({
        appSessionId: appSessions.id,
        cronJobId: cronJobBindings.cronJobId,
        title: appSessions.titleOverride,
        outputKind: cronJobBindings.outputKind,
        notifyOnRun: cronJobBindings.notifyOnRun,
        createdAt: cronJobBindings.createdAt,
        updatedAt: appSessions.updatedAt,
      })
      .from(cronJobBindings)
      .innerJoin(appSessions, eq(appSessions.id, cronJobBindings.appSessionId))
      .where(
        and(
          eq(cronJobBindings.userId, user.id),
          eq(appSessions.kind, "cron_inbox"),
        ),
      )
      .orderBy(desc(appSessions.updatedAt));
    return reply.send({
      inboxes: rows.map((r) => ({
        appSessionId: r.appSessionId,
        cronJobId: r.cronJobId,
        title: r.title ?? "Untitled",
        outputKind: r.outputKind as "inbox" | "session",
        notifyOnRun: r.notifyOnRun,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    });
  });

  // Cron outputs are FS-only — Hermes does not expose them via HTTP (per contract).
  app.get("/cron/outputs", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = outputsQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query" });
    const outputs = await listCronOutputs(hermesHome, parsed.data.job_id);
    return reply.send({ outputs });
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
