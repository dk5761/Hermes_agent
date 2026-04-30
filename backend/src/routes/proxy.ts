import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import type { HermesHttpClient } from "../hermes/http-client.js";

export interface ProxyRoutesDeps {
  requireAuth: preHandlerHookHandler;
  hermesHttp: HermesHttpClient;
}

const logsQuery = z.object({
  file: z.string().min(1).optional(),
  lines: z.coerce.number().int().positive().max(10_000).optional(),
});

const analyticsQuery = z.object({
  days: z.coerce.number().int().positive().max(365).optional(),
});

export async function registerProxyRoutes(
  app: FastifyInstance,
  deps: ProxyRoutesDeps,
): Promise<void> {
  const { requireAuth, hermesHttp } = deps;

  app.get("/model/info", { preHandler: requireAuth }, async (_req, reply) => {
    return reply.send(await hermesHttp.modelInfo());
  });

  app.get("/skills", { preHandler: requireAuth }, async (_req, reply) => {
    return reply.send(await hermesHttp.listSkills());
  });

  app.get("/tools/toolsets", { preHandler: requireAuth }, async (_req, reply) => {
    return reply.send(await hermesHttp.listToolsets());
  });

  app.get("/logs", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = logsQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query" });
    return reply.send(await hermesHttp.logs(parsed.data));
  });

  app.get("/analytics/usage", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = analyticsQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query" });
    return reply.send(await hermesHttp.analytics(parsed.data));
  });
}
