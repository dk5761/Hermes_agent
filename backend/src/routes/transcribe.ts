import { z } from "zod";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { appSessions } from "../db/schema.js";
import type { HermesWsPool } from "../hermes/ws-pool.js";
import type { HermesWsClient } from "../hermes/ws-client.js";
import type { AppLogger } from "../logger.js";
import { HermesRpcError } from "../hermes/types.js";

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

/** Strict shape expected from the Hermes `stt.transcribe` RPC result. */
interface SttTranscribeResult {
  success: boolean;
  transcript: string;
  provider: string;
}

const sttResultSchema = z.object({
  success: z.boolean(),
  transcript: z.string(),
  provider: z.string(),
});

// --------------------------------------------------------------------------
// Deps
// --------------------------------------------------------------------------

export interface TranscribeRoutesDeps {
  db: Db;
  requireAuth: preHandlerHookHandler;
  wsPool: HermesWsPool;
  logger: AppLogger;
}

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

/** Hard deadline placed on top of the WS client's own timeout. */
const TRANSCRIBE_TIMEOUT_MS = 30_000;

/** Per-route audio size cap (10 MB). Enforced at parse time via multipart limits. */
const AUDIO_SIZE_LIMIT_BYTES = 10 * 1024 * 1024;

// --------------------------------------------------------------------------
// Helper: transcribeWithRetry
// --------------------------------------------------------------------------

/**
 * Issues a `stt.transcribe` RPC with one transparent retry on the stale-worker
 * path. Mirrors the `slashExecWithRetry` pattern from `sessions.ts`.
 *
 * Hermes code 5030 signals a stale/exited worker subprocess. On that first
 * failure the dashboard clears the slot, so the second call succeeds with a
 * fresh worker. Code 5041 covers generic STT failures — those are NOT retried
 * because retrying won't help (the audio is valid, the failure is upstream).
 *
 * @param client  Shared WS client from the pool.
 * @param params  `{ audio_b64, mime }` payload forwarded to Hermes.
 * @param timeoutMs  Per-attempt deadline in milliseconds.
 * @returns  Parsed `SttTranscribeResult` on success.
 * @throws  `HermesRpcError` for non-retryable RPC errors.
 * @throws  `Error("upstream_request_timeout:stt.transcribe")` on timeout.
 */
async function transcribeWithRetry(
  client: HermesWsClient,
  params: { audio_b64: string; mime: string },
  timeoutMs: number,
): Promise<SttTranscribeResult> {
  const once = (): Promise<unknown> =>
    Promise.race([
      client.request("stt.transcribe", params),
      new Promise((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("upstream_request_timeout:stt.transcribe")),
          timeoutMs,
        ).unref(),
      ),
    ]);

  const parseResult = (raw: unknown): SttTranscribeResult => {
    const parsed = sttResultSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error("bad_response:stt.transcribe");
    }
    return parsed.data;
  };

  try {
    return parseResult(await once());
  } catch (err) {
    // Retry only on the "stale slash worker" path (code 5030). Any other
    // error — including actual STT failure (5041) — surfaces to the caller.
    const isStaleWorker =
      err instanceof HermesRpcError &&
      err.code === 5030 &&
      /slash worker/i.test(err.message);
    if (!isStaleWorker) throw err;
    return parseResult(await once());
  }
}

// --------------------------------------------------------------------------
// Route registration
// --------------------------------------------------------------------------

/**
 * Registers `POST /sessions/:id/transcribe`.
 *
 * Accepts a multipart upload with a single `audio` field containing binary
 * audio data (M4A/AAC expected from mobile). Converts the audio to base64,
 * calls the Hermes `stt.transcribe` RPC via the shared WS pool, and returns
 * the transcript with provider attribution and round-trip duration.
 */
export async function registerTranscribeRoutes(
  app: FastifyInstance,
  deps: TranscribeRoutesDeps,
): Promise<void> {
  const { db, requireAuth, wsPool, logger } = deps;

  app.post(
    "/sessions/:id/transcribe",
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = request.user;
      if (!user) return reply.code(401).send({ error: "unauthenticated" });

      // Validate :id param
      const paramsResult = z.object({ id: z.string().min(1) }).safeParse(request.params);
      if (!paramsResult.success) {
        return reply.code(400).send({ error: "invalid_params" });
      }
      const sessionId = paramsResult.data.id;

      // Verify session ownership
      const rows = await db
        .select({ id: appSessions.id })
        .from(appSessions)
        .where(and(eq(appSessions.id, sessionId), eq(appSessions.userId, user.id)))
        .limit(1);
      if (!rows[0]) return reply.code(404).send({ error: "not_found" });

      // Parse multipart body — enforce per-route 10 MB size cap.
      // The global multipart registration uses UPLOAD_BODY_LIMIT_BYTES which
      // may be larger; the per-call limit here is the authoritative cap for
      // audio uploads.
      let data: Awaited<ReturnType<typeof request.file>>;
      try {
        data = await request.file({ limits: { fileSize: AUDIO_SIZE_LIMIT_BYTES } });
      } catch (err) {
        // @fastify/multipart throws when the file part exceeds the limit.
        const msg = err instanceof Error ? err.message : "";
        if (/limit/i.test(msg) || /size/i.test(msg)) {
          return reply.code(413).send({ error: "too_large" });
        }
        logger.warn({ err, sessionId }, "multipart parse error");
        return reply.code(400).send({ error: "invalid_body" });
      }

      if (!data) {
        return reply.code(400).send({ error: "missing_audio" });
      }

      // Field name must be "audio"
      if (data.fieldname !== "audio") {
        // Drain the stream to avoid backpressure
        await data.toBuffer().catch(() => undefined);
        return reply.code(400).send({ error: "missing_audio" });
      }

      // Read into buffer. bytesRead check catches the edge case where the
      // framework lets the stream through but the part exceeds our cap.
      const buffer = await data.toBuffer();
      if (data.file.truncated || buffer.byteLength > AUDIO_SIZE_LIMIT_BYTES) {
        return reply.code(413).send({ error: "too_large" });
      }
      if (buffer.byteLength === 0) {
        return reply.code(400).send({ error: "missing_audio" });
      }

      const mime = data.mimetype ?? "audio/m4a";
      const audio_b64 = buffer.toString("base64");

      const client = wsPool.getOrCreateShared();
      const start = Date.now();

      let result: SttTranscribeResult;
      try {
        result = await transcribeWithRetry(
          client,
          { audio_b64, mime },
          TRANSCRIBE_TIMEOUT_MS,
        );
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("upstream_request_timeout")) {
          logger.warn({ sessionId }, "stt.transcribe timed out");
          return reply.code(504).send({ error: "stt_timeout" });
        }
        if (err instanceof Error && err.message === "bad_response:stt.transcribe") {
          logger.warn({ sessionId }, "stt.transcribe returned unexpected shape");
          return reply.code(502).send({ error: "bad_response" });
        }
        if (err instanceof HermesRpcError) {
          logger.warn({ err, sessionId, code: err.code }, "stt.transcribe RPC error");
          return reply.code(503).send({ error: "stt_failed", message: err.message });
        }
        // Non-RPC error (network, pool closing, etc.)
        logger.warn({ err, sessionId }, "stt.transcribe unexpected error");
        return reply.code(503).send({ error: "stt_failed" });
      }

      if (!result.success) {
        logger.warn({ sessionId, result }, "stt.transcribe returned success=false");
        return reply.code(503).send({ error: "stt_failed" });
      }

      return reply.send({
        transcript: result.transcript ?? "",
        provider: result.provider ?? "unknown",
        durationMs: Date.now() - start,
      });
    },
  );
}
