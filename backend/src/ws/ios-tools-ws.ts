import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import type { Db } from "../db/client.js";
import type { AppLogger } from "../logger.js";
import type { JwtConfig } from "../auth/jwt.js";
import { verifyWsAuth } from "../middleware/require-auth-ws.js";
import type { IosToolsRouter } from "./ios-tools-router.js";
import type { IosToolResultFrame } from "../types/ios-tools.js";

export interface IosToolsWsDeps {
  db: Db;
  jwt: JwtConfig;
  logger: AppLogger;
  iosToolsRouter: IosToolsRouter;
}

const iosToolResultFrameSchema = z.object({
  type: z.literal("ios_tool_result"),
  call_id: z.string().min(1),
  ok: z.boolean(),
  result: z.record(z.unknown()).optional(),
  error: z
    .object({
      code: z.string().min(1),
      message: z.string(),
    })
    .optional(),
});

const clientFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }),
  iosToolResultFrameSchema,
]);

export async function registerIosToolsWsRoute(
  app: FastifyInstance,
  deps: IosToolsWsDeps,
): Promise<void> {
  const log = deps.logger.child({ component: "ios-tools-ws" });

  app.get(
    "/ws/ios-tools",
    { websocket: true },
    async (socket: WebSocket, request: FastifyRequest) => {
      const user = await verifyWsAuth(request, {
        db: deps.db,
        jwt: deps.jwt,
      });
      if (!user) {
        closeWith(socket, 4401, "unauthenticated");
        return;
      }

      const detach = deps.iosToolsRouter.registerWs(user.id, socket, "root");
      const sendControl = (type: string, payload?: unknown): void => {
        socket.send(JSON.stringify({ type, payload }));
      };

      socket.on("message", (data: Buffer) => {
        let json: unknown;
        try {
          json = JSON.parse(data.toString("utf8"));
        } catch {
          sendControl("control.error", { error: "invalid_json" });
          return;
        }
        const parsed = clientFrameSchema.safeParse(json);
        if (!parsed.success) {
          sendControl("control.error", { error: "invalid_frame" });
          return;
        }
        if (parsed.data.type === "ping") {
          sendControl("ack", { pong: true });
          return;
        }
        deps.iosToolsRouter.onResult(parsed.data as IosToolResultFrame);
      });

      socket.on("close", detach);
      socket.on("error", (err: unknown) => {
        log.warn({ err, userId: user.id }, "ios tools WS error");
        detach();
      });

      sendControl("gateway.ready", { iosTools: true });
    },
  );
}

function closeWith(socket: WebSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // Ignore close failures: the connection is already unusable.
  }
}
