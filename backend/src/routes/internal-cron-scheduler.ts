// POST /internal/cron-scheduler/create — MCP stdio server → gateway bridge.
//
// Auth: Authorization: Bearer ${IOS_MCP_TOKEN}. Loopback-only (matches the
// existing /internal/ios-tool pattern). The same token gates this endpoint
// because both surfaces are equivalent in trust level — an MCP child process
// hermes spawned that needs to talk to the gateway over loopback.
//
// What this does (atomically, inside a single SQLite transaction):
//   1. Calls Hermes' POST /api/cron/jobs to create the cron entry.
//   2. If output_target.kind === "inbox": mints a new app_session with
//      kind='cron_inbox' and cron_job_id pointing at the freshly-created
//      job. Title defaults to inbox_name or the cron's name.
//   3. If output_target.kind === "current_session": validates the session
//      exists and is owned by the user.
//   4. Inserts a row into cron_job_bindings linking job → session.
//   5. Returns { ok:true, jobId, appSessionId, output_kind }.
//
// Failure modes:
//   - missing output_target → returns ok:false with code='needs_output_target'
//     so the MCP server can format a clarify message back to the agent.
//   - Hermes /api/cron/jobs fails → returns ok:false, code='hermes_create_failed'.
//   - Invalid current_session_id → ok:false, code='invalid_session'.

import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { appSessions, cronJobBindings } from "../db/schema.js";
import type { HermesHttpClient } from "../hermes/http-client.js";
import type { AppLogger } from "../logger.js";

export interface InternalCronSchedulerDeps {
  db: Db;
  hermesHttp: HermesHttpClient;
  /** Shared loopback bearer token. Reuses IOS_MCP_TOKEN by convention. */
  internalToken: string;
  logger: AppLogger;
}

const outputTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("inbox"),
    inbox_name: z.string().min(1).max(120).optional(),
  }),
  z.object({
    kind: z.literal("current_session"),
    app_session_id: z.string().min(1),
  }),
]);

const createBodySchema = z.object({
  user_id: z.string().min(1),
  name: z.string().min(1).max(120),
  cron: z.string().min(1).max(120),
  prompt: z.string().min(1).max(8000),
  // Optional so the MCP layer can detect a missing target and surface a
  // structured clarify response to the agent.
  output_target: outputTargetSchema.optional(),
});

const LOOPBACK_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export async function registerInternalCronSchedulerRoutes(
  app: FastifyInstance,
  deps: InternalCronSchedulerDeps,
): Promise<void> {
  const log = deps.logger.child({ component: "internal-cron-scheduler" });

  app.post("/internal/cron-scheduler/create", async (request, reply) => {
    // Loopback guard.
    const ip = request.ip;
    if (!LOOPBACK_IPS.has(ip)) {
      log.warn({ ip }, "rejected non-loopback request");
      return reply.code(403).send({ error: "forbidden" });
    }

    const authHeader = request.headers.authorization ?? "";
    if (authHeader !== `Bearer ${deps.internalToken}`) {
      log.warn({ ip }, "invalid bearer token");
      return reply.code(401).send({ error: "unauthorized" });
    }

    const parsed = createBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_body",
        details: parsed.error.flatten(),
      });
    }
    const { user_id: userId, name, cron, prompt, output_target } = parsed.data;

    // Surface a structured "needs output target" so the agent prompts the user.
    if (!output_target) {
      log.info({ userId, name }, "schedule_chat_task: missing output_target");
      return reply.code(200).send({
        ok: false,
        error: {
          code: "needs_output_target",
          message:
            "Where should this scheduled task's output go? Ask the user to choose: 'inbox' (default — a new dedicated thread for this cron) or 'current_session' (output appears in the current chat). Then call schedule_chat_task again with the chosen output_target.",
        },
      });
    }

    // For current_session: validate ownership before creating the cron.
    if (output_target.kind === "current_session") {
      const sess = await deps.db
        .select({ id: appSessions.id, kind: appSessions.kind })
        .from(appSessions)
        .where(
          and(
            eq(appSessions.id, output_target.app_session_id),
            eq(appSessions.userId, userId),
          ),
        )
        .limit(1);
      if (sess.length === 0) {
        return reply.code(200).send({
          ok: false,
          error: {
            code: "invalid_session",
            message: `app_session_id ${output_target.app_session_id} not found for user`,
          },
        });
      }
      // Refuse to bind to an inbox — would create a circular destination.
      if (sess[0]?.kind === "cron_inbox") {
        return reply.code(200).send({
          ok: false,
          error: {
            code: "invalid_session",
            message: "Cannot bind a cron to an existing cron inbox",
          },
        });
      }
    }

    // 1) Create the Hermes cron job. This RPC is the source of truth for the
    // schedule — failure here means we don't insert any local state.
    let jobId: string;
    try {
      // Hermes' POST /api/cron/jobs (CronJobCreate) takes:
      //   prompt: str, schedule: str (cron expression), name: str, deliver: str
      // The richer { kind, expr } object lives only in the persisted job.json
      // model — the create API expects a flat cron string.
      const created = (await deps.hermesHttp.createCronJob({
        name,
        prompt,
        schedule: cron,
        deliver: "local",
      })) as Record<string, unknown>;
      const id = created["id"];
      if (typeof id !== "string" || id.length === 0) {
        throw new Error("Hermes /api/cron/jobs returned no id");
      }
      jobId = id;
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown";
      log.error({ err, name, cron }, "Hermes cron create failed");
      return reply.code(200).send({
        ok: false,
        error: {
          code: "hermes_create_failed",
          message: `Failed to create cron in Hermes: ${message}`,
        },
      });
    }

    // 2 + 3) Mint inbox session + insert binding atomically.
    const now = Math.floor(Date.now() / 1000);
    let appSessionId: string;
    try {
      appSessionId = await deps.db.transaction((tx) => {
        let sid: string;
        if (output_target.kind === "inbox") {
          sid = crypto.randomUUID();
          const inboxTitle = output_target.inbox_name ?? name;
          tx.insert(appSessions)
            .values({
              id: sid,
              userId,
              hermesSessionId: null,
              titleOverride: inboxTitle,
              archivedAt: null,
              createdAt: now,
              updatedAt: now,
              kind: "cron_inbox",
              cronJobId: jobId,
            })
            .run();
        } else {
          sid = output_target.app_session_id;
        }

        tx.insert(cronJobBindings)
          .values({
            cronJobId: jobId,
            userId,
            appSessionId: sid,
            outputKind: output_target.kind === "inbox" ? "inbox" : "session",
            hermesSessionId: null,
            // Default: notify on inbox runs (user wouldn't otherwise see them)
            // but not on current-session runs (the user is already in the chat).
            notifyOnRun: output_target.kind === "inbox",
            createdAt: now,
          })
          .run();
        return sid;
      });
    } catch (err) {
      // Local state insert failed — best-effort cleanup of the Hermes job we
      // just created so the user doesn't see a phantom schedule with no
      // destination. If THIS fails too, we log and continue; reconciliation
      // is a manual operation.
      log.error({ err, jobId, userId }, "binding insert failed; rolling back Hermes job");
      try {
        await deps.hermesHttp.deleteCronJob(jobId);
      } catch (cleanupErr) {
        log.warn({ cleanupErr, jobId }, "rollback Hermes delete failed; manual cleanup needed");
      }
      return reply.code(500).send({
        ok: false,
        error: {
          code: "binding_insert_failed",
          message: err instanceof Error ? err.message : "unknown",
        },
      });
    }

    log.info(
      {
        userId,
        jobId,
        appSessionId,
        outputKind: output_target.kind,
        cron,
        name,
      },
      "scheduled chat task",
    );

    return reply.code(200).send({
      ok: true,
      result: {
        jobId,
        appSessionId,
        outputKind: output_target.kind,
        scheduledFor: cron,
      },
    });
  });
}
