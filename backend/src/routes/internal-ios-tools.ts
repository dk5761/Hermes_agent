// POST /internal/ios-tool — MCP stdio server → gateway bridge.
//
// Auth: Authorization: Bearer ${IOS_MCP_TOKEN}. The route also enforces that
// the request arrives from 127.0.0.1 or ::1 (loopback only). This is an
// internal-only endpoint; it must never be exposed to the public internet.
//
// The MCP stdio server (Phase 5) POSTs here. The gateway looks up the user's
// active mobile WS and forwards the call via ios-tools-router. Returns:
//
//   { ok: true,  result: { ... } }         on success
//   { ok: false, error: { code, message } } on any IosToolError

import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { IosToolsRouter } from "../ws/ios-tools-router.js";
import type { AppLogger } from "../logger.js";
import { IosToolError, type IosToolName } from "../types/ios-tools.js";

export interface InternalIosToolsDeps {
  iosToolsRouter: IosToolsRouter;
  iosMcpToken: string;
  logger: AppLogger;
}

const requestBodySchema = z.object({
  user_id: z.string().min(1),
  tool: z.string().min(1) as z.ZodType<IosToolName>,
  args: z.record(z.unknown()).default({}),
  /** Override default 30s timeout (milliseconds). */
  timeout_ms: z.coerce.number().int().positive().optional(),
});

const LOOPBACK_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export async function registerInternalIosToolsRoutes(
  app: FastifyInstance,
  deps: InternalIosToolsDeps,
): Promise<void> {
  const log = deps.logger.child({ component: "internal-ios-tools" });

  app.post(
    "/internal/ios-tool",
    // Intentionally no requireAuth preHandler — this route uses its own
    // bearer token check below to avoid coupling to the user JWT stack.
    async (request, reply) => {
      // ── Loopback guard ──────────────────────────────────────────────────
      const ip = request.ip;
      if (!LOOPBACK_IPS.has(ip)) {
        log.warn({ ip }, "internal/ios-tool: rejected non-loopback request");
        return reply.code(403).send({ error: "forbidden" });
      }

      // ── Bearer token check ──────────────────────────────────────────────
      const authHeader = request.headers.authorization ?? "";
      const expectedBearer = `Bearer ${deps.iosMcpToken}`;
      if (authHeader !== expectedBearer) {
        log.warn({ ip }, "internal/ios-tool: invalid bearer token");
        return reply.code(401).send({ error: "unauthorized" });
      }

      // ── Body validation ─────────────────────────────────────────────────
      const parsed = requestBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_body",
          details: parsed.error.flatten(),
        });
      }

      const { user_id: userId, tool, args, timeout_ms: timeoutMs } = parsed.data;

      log.info({ userId, tool }, "internal/ios-tool: dispatching");

      try {
        const result = await deps.iosToolsRouter.call(
          userId,
          tool,
          args,
          timeoutMs ?? 30_000,
        );
        return reply.code(200).send({ ok: true, result });
      } catch (err) {
        if (err instanceof IosToolError) {
          log.info({ userId, tool, code: err.code }, "internal/ios-tool: tool error");
          return reply.code(200).send({
            ok: false,
            error: { code: err.code, message: err.message },
          });
        }
        log.error({ err, userId, tool }, "internal/ios-tool: unexpected error");
        return reply.code(200).send({
          ok: false,
          error: { code: "unknown", message: String(err) },
        });
      }
    },
  );
}
