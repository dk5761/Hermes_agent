import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { appSessions, chatHistory } from "../db/schema.js";
import type { HermesWsPool } from "../hermes/ws-pool.js";
import type { AppLogger } from "../logger.js";
import { HermesRpcError } from "../hermes/types.js";
import { transcribeWithRetry } from "./transcribe.js";
import { ensureHermesSession } from "../sessions/ensure-hermes-session.js";
import { extractAudioPeaks } from "../blobs/audio-peaks.js";

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

/** Per-route audio size cap (10 MB). */
const AUDIO_SIZE_LIMIT_BYTES = 10 * 1024 * 1024;

/** Maximum allowed duration passed by the client (10 minutes in ms). */
const MAX_DURATION_MS = 600_000;

/** Timeout forwarded to transcribeWithRetry. */
const STT_TIMEOUT_MS = 30_000;

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

export interface VoiceMemoRoutesDeps {
  db: Db;
  requireAuth: preHandlerHookHandler;
  wsPool: HermesWsPool;
  /** Absolute path to the blob root directory (STORAGE_LOCAL_ROOT). */
  blobRoot: string;
  logger: AppLogger;
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * Choose a file extension from the MIME type.
 * Mirrors the logic in patch-hermes-stt-rpc.py.
 */
function extFromMime(mime: string): string {
  if (/m4a|aac/i.test(mime)) return ".m4a";
  if (/mpeg|mp3/i.test(mime)) return ".mp3";
  if (/wav/i.test(mime)) return ".wav";
  return ".m4a"; // safe fallback
}

/**
 * Accepted audio MIME types. Rejects non-audio uploads early.
 */
function isAudioMime(mime: string): boolean {
  return /^audio\//i.test(mime);
}

/**
 * Return the relative `voice/<sha><ext>` key, writing the file if it does
 * not already exist (sha-dedup for identical recordings).
 *
 * @param blobRoot  Absolute path to the blob store root.
 * @param sha       Hex sha256 of the audio bytes.
 * @param ext       File extension including leading dot.
 * @param buffer    Raw audio bytes to persist.
 * @returns Relative key `voice/<sha><ext>` (no leading slash).
 */
async function writeVoiceBlob(
  blobRoot: string,
  sha: string,
  ext: string,
  buffer: Buffer,
): Promise<string> {
  const voiceDir = path.join(blobRoot, "voice");
  await fsp.mkdir(voiceDir, { recursive: true });
  const relKey = `voice/${sha}${ext}`;
  const dest = path.join(blobRoot, relKey);
  try {
    await fsp.access(dest);
    // File already exists — reuse (sha dedup).
  } catch {
    await fsp.writeFile(dest, buffer);
  }
  return relKey;
}

/**
 * Forward a transcript as a normal user prompt to Hermes.
 *
 * Replicates the core of `handleChatSend` without WS-specific concerns
 * (no ws_events persistence, no attachment bridge). Called after a
 * successful STT result so Hermes can stream an assistant reply.
 *
 * On `session_gone`-style errors the session is cleared from the DB and
 * a fresh one is created before retrying. Non-recoverable errors are
 * logged and swallowed — the user message row is already persisted; the
 * worst case is Hermes never generates a reply for this turn.
 *
 * @param db           Drizzle database handle.
 * @param wsPool       Shared Hermes WS pool.
 * @param appSessionId App session PK.
 * @param text         Transcript text to submit.
 * @param logger       Structured logger.
 */
async function forwardTranscriptToHermes(
  db: Db,
  wsPool: HermesWsPool,
  appSessionId: string,
  text: string,
  logger: AppLogger,
): Promise<void> {
  const client = wsPool.getOrCreateShared();

  let hermesSessionId: string;
  try {
    hermesSessionId = await ensureHermesSession({
      db,
      wsPool,
      appSessionId,
      logger,
    });
  } catch (err) {
    logger.warn({ err, appSessionId }, "voice-memo: ensureHermesSession failed");
    return;
  }

  const submitOnce = async (hsid: string): Promise<void> => {
    await client.request("prompt.submit", {
      session_id: hsid,
      text,
    });
  };

  try {
    await submitOnce(hermesSessionId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const sessionGone =
      /session/i.test(msg) &&
      /not found|unknown|invalid|expired|missing|no such|gone|evicted/i.test(msg);
    const sessionBusy = /4009|session busy|busy/i.test(msg);
    const isInvalidParams = /-32602|invalid params/i.test(msg);

    if (sessionBusy && !sessionGone && !isInvalidParams) {
      // Interrupt the stuck session and retry once.
      try {
        await client.request("session.interrupt", { session_id: hermesSessionId });
        await new Promise((r) => setTimeout(r, 300));
        await submitOnce(hermesSessionId);
        return;
      } catch (retryErr) {
        logger.error({ err: retryErr, appSessionId }, "voice-memo: prompt.submit retry after interrupt failed");
      }
    }

    if (sessionGone || isInvalidParams || sessionBusy) {
      // Recreate the session and retry.
      try {
        const now = Math.floor(Date.now() / 1000);
        await db
          .update(appSessions)
          .set({ hermesSessionId: null, updatedAt: now })
          .where(eq(appSessions.id, appSessionId));
        const fresh = await ensureHermesSession({
          db,
          wsPool,
          appSessionId,
          logger,
        });
        await submitOnce(fresh);
        return;
      } catch (retryErr) {
        logger.error({ err: retryErr, appSessionId }, "voice-memo: prompt.submit retry after recreate failed");
      }
    }

    logger.warn({ err, appSessionId }, "voice-memo: prompt.submit failed (non-recoverable)");
  }
}

/**
 * Validate a raw JSON string received from the client as `audioPeaks`.
 *
 * Rules:
 *   - Must parse as JSON array.
 *   - Length must equal exactly 80.
 *   - Every element must be a finite number in [0, 1].
 *
 * @param raw  Raw JSON string from the multipart field, or null if absent.
 * @returns Validated peaks array, or null if absent / invalid.
 */
function parseClientPeaks(raw: string | null): number[] | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 80) return null;
  for (const v of parsed) {
    if (typeof v !== "number" || !isFinite(v) || v < 0 || v > 1) return null;
  }
  return parsed as number[];
}

/**
 * Resolve audio peaks, preferring client-supplied values over ffmpeg extraction.
 *
 * If `clientPeaksRaw` is a valid 80-element float[0..1] JSON array, it is used
 * directly and ffmpeg is skipped. Otherwise falls back to `extractAudioPeaks`.
 *
 * @param absolutePath   Path to the stored audio blob.
 * @param clientPeaksRaw Raw `audioPeaks` multipart field value, or null.
 * @param sessionId      For structured log context.
 * @param logger         Structured logger.
 * @returns 80-element peaks array, or null on extraction failure.
 */
async function resolveAudioPeaks(
  absolutePath: string,
  clientPeaksRaw: string | null,
  sessionId: string,
  logger: AppLogger,
): Promise<number[] | null> {
  const clientPeaks = parseClientPeaks(clientPeaksRaw);

  if (clientPeaks !== null) {
    logger.info({ sessionId, source: "client" }, "voice memo peaks from client");
    return clientPeaks;
  }

  if (clientPeaksRaw !== null) {
    // Field was present but failed validation — warn before falling back.
    logger.warn({ sessionId }, "voice-memo: client audioPeaks invalid, falling back to ffmpeg");
  }

  logger.info({ sessionId, source: "ffmpeg" }, "voice memo peaks via ffmpeg");
  const peaks = await extractAudioPeaks(absolutePath).catch(() => null);
  if (peaks === null) {
    logger.warn({ blobPath: absolutePath }, "audio peaks extraction failed; storing null");
  }
  return peaks;
}

// Builds the message envelope sent back to the client.
function buildMessageEnvelope(row: {
  id: number;
  content: string;
  audioBlobPath: string;
  audioDurationMs: number | null;
  transcriptionStatus: string;
  transcriptionError: string | null;
  createdAt: number;
  audioPeaks: number[] | null;
}) {
  return {
    id: row.id,
    role: "user" as const,
    content: row.content,
    audioBlobUrl: `/voice-blobs/${row.audioBlobPath}`,
    audioDurationMs: row.audioDurationMs,
    transcriptionStatus: row.transcriptionStatus,
    transcriptionError: row.transcriptionError,
    createdAt: row.createdAt,
    audioPeaks: row.audioPeaks,
  };
}

// --------------------------------------------------------------------------
// Route registration
// --------------------------------------------------------------------------

/**
 * Registers voice memo HTTP routes:
 *   POST /sessions/:id/messages/voice
 *   POST /sessions/:id/messages/:msgId/retry-transcription
 *   GET  /voice-blobs/voice/:sha.:ext  (auth-gated blob serve)
 *
 * @param app  Fastify instance.
 * @param deps Route dependencies.
 */
export async function registerVoiceMemoRoutes(
  app: FastifyInstance,
  deps: VoiceMemoRoutesDeps,
): Promise<void> {
  const { db, requireAuth, wsPool, blobRoot, logger } = deps;

  // ---------- Route A: POST /sessions/:id/messages/voice ----------

  app.post(
    "/sessions/:id/messages/voice",
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = request.user;
      if (!user) return reply.code(401).send({ error: "unauthenticated" });

      const paramsResult = z.object({ id: z.string().min(1) }).safeParse(request.params);
      if (!paramsResult.success) {
        return reply.code(400).send({ error: "invalid_params" });
      }
      const sessionId = paramsResult.data.id;

      // Session ownership check.
      const sessionRows = await db
        .select({ id: appSessions.id })
        .from(appSessions)
        .where(and(eq(appSessions.id, sessionId), eq(appSessions.userId, user.id)))
        .limit(1);
      if (!sessionRows[0]) return reply.code(404).send({ error: "not_found" });

      // Parse multipart body with request.parts() so we can read both the
      // `audio` file part and the optional `audioDurationMs` / `audioPeaks`
      // field parts in one pass. The per-part fileSize limit mirrors the
      // transcribe route.
      let buffer: Buffer | null = null;
      let mime = "audio/m4a";
      let audioDurationMs: number | null = null;
      let clientPeaksRaw: string | null = null;
      let truncated = false;

      try {
        const parts = request.parts({ limits: { fileSize: AUDIO_SIZE_LIMIT_BYTES } });
        for await (const part of parts) {
          if (part.type === "file" && part.fieldname === "audio") {
            buffer = await part.toBuffer();
            mime = part.mimetype ?? "audio/m4a";
            truncated = part.file.truncated;
          } else if (part.type === "field" && part.fieldname === "audioDurationMs") {
            const parsed = Number(part.value);
            if (Number.isFinite(parsed) && parsed >= 0) {
              audioDurationMs = Math.min(Math.floor(parsed), MAX_DURATION_MS);
            }
          } else if (part.type === "field" && part.fieldname === "audioPeaks") {
            clientPeaksRaw = typeof part.value === "string" ? part.value : null;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (/limit/i.test(msg) || /size/i.test(msg)) {
          return reply.code(413).send({ error: "too_large" });
        }
        logger.warn({ err, sessionId }, "voice-memo: multipart parse error");
        return reply.code(400).send({ error: "invalid_body" });
      }

      if (!buffer) {
        return reply.code(400).send({ error: "missing_audio" });
      }
      if (truncated || buffer.byteLength > AUDIO_SIZE_LIMIT_BYTES) {
        return reply.code(413).send({ error: "too_large" });
      }
      if (buffer.byteLength === 0) {
        return reply.code(400).send({ error: "missing_audio" });
      }
      if (!isAudioMime(mime)) {
        return reply.code(400).send({ error: "invalid_mime", message: "audio/* required" });
      }

      // Compute sha256 → store blob.
      const sha = crypto.createHash("sha256").update(buffer).digest("hex");
      const ext = extFromMime(mime);
      let relKey: string;
      try {
        relKey = await writeVoiceBlob(blobRoot, sha, ext, buffer);
      } catch (err) {
        logger.error({ err, sessionId }, "voice-memo: blob write failed");
        return reply.code(500).send({ error: "blob_write_failed" });
      }

      // Extract audio peaks for waveform visualization. Client peaks are
      // preferred (skip expensive ffmpeg call). Falls back to ffmpeg when the
      // client didn't send peaks or the payload fails validation.
      const absolutePath = path.join(blobRoot, relKey);
      const peaks = await resolveAudioPeaks(absolutePath, clientPeaksRaw, sessionId, logger);

      // Insert chat_history row immediately so the blob + row survive STT failure.
      const now = Math.floor(Date.now() / 1000);
      const inserted = await db
        .insert(chatHistory)
        .values({
          appSessionId: sessionId,
          kind: "user.message",
          payloadJson: JSON.stringify({ text: "" }),
          searchText: "",
          createdAt: now,
          audioBlobPath: relKey,
          audioDurationMs,
          audioPeaksJson: peaks !== null ? JSON.stringify(peaks) : null,
          transcriptionStatus: "transcribing",
          transcriptionError: null,
        })
        .returning({ id: chatHistory.id });
      const rowId = inserted[0]?.id;
      if (rowId === undefined) {
        logger.error({ sessionId }, "voice-memo: chat_history insert returned no row");
        return reply.code(500).send({ error: "db_error" });
      }

      // Transcribe.
      const audio_b64 = buffer.toString("base64");
      const client = wsPool.getOrCreateShared();

      let transcript: string;
      let sttOk: boolean;
      let sttError: string | null = null;

      try {
        const result = await transcribeWithRetry(client, { audio_b64, mime }, STT_TIMEOUT_MS);
        if (!result.success) {
          throw new Error("stt.transcribe returned success=false");
        }
        transcript = result.transcript;
        sttOk = true;
      } catch (err) {
        sttOk = false;
        sttError =
          err instanceof HermesRpcError
            ? `${err.message} (code ${err.code})`
            : err instanceof Error
              ? err.message
              : String(err);
        logger.warn({ err, sessionId, rowId }, "voice-memo: STT failed");
        transcript = "";
      }

      if (sttOk) {
        // SUCCESS: update row with transcript and forward to Hermes.
        await db
          .update(chatHistory)
          .set({
            payloadJson: JSON.stringify({ text: transcript }),
            searchText: transcript,
            transcriptionStatus: "completed",
            transcriptionError: null,
          })
          .where(eq(chatHistory.id, rowId));

        void forwardTranscriptToHermes(db, wsPool, sessionId, transcript, logger);

        return reply.code(201).send({
          message: buildMessageEnvelope({
            id: rowId,
            content: transcript,
            audioBlobPath: relKey,
            audioDurationMs,
            transcriptionStatus: "completed",
            transcriptionError: null,
            createdAt: now,
            audioPeaks: peaks,
          }),
        });
      } else {
        // FAILURE: persist the failure status; blob stays on disk for retry.
        await db
          .update(chatHistory)
          .set({
            transcriptionStatus: "failed",
            transcriptionError: sttError,
          })
          .where(eq(chatHistory.id, rowId));

        return reply.code(201).send({
          message: buildMessageEnvelope({
            id: rowId,
            content: "",
            audioBlobPath: relKey,
            audioDurationMs,
            transcriptionStatus: "failed",
            transcriptionError: sttError,
            createdAt: now,
            audioPeaks: peaks,
          }),
        });
      }
    },
  );

  // ---------- Route B: POST /sessions/:id/messages/:msgId/retry-transcription ----------

  app.post(
    "/sessions/:id/messages/:msgId/retry-transcription",
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = request.user;
      if (!user) return reply.code(401).send({ error: "unauthenticated" });

      const paramsResult = z
        .object({ id: z.string().min(1), msgId: z.coerce.number().int().positive() })
        .safeParse(request.params);
      if (!paramsResult.success) {
        return reply.code(400).send({ error: "invalid_params" });
      }
      const { id: sessionId, msgId } = paramsResult.data;

      // Session ownership check.
      const sessionRows = await db
        .select({ id: appSessions.id })
        .from(appSessions)
        .where(and(eq(appSessions.id, sessionId), eq(appSessions.userId, user.id)))
        .limit(1);
      if (!sessionRows[0]) return reply.code(404).send({ error: "not_found" });

      // Fetch the target message row.
      const msgRows = await db
        .select({
          id: chatHistory.id,
          appSessionId: chatHistory.appSessionId,
          audioBlobPath: chatHistory.audioBlobPath,
          audioDurationMs: chatHistory.audioDurationMs,
          transcriptionStatus: chatHistory.transcriptionStatus,
          createdAt: chatHistory.createdAt,
          audioPeaksJson: chatHistory.audioPeaksJson,
        })
        .from(chatHistory)
        .where(and(eq(chatHistory.id, msgId), eq(chatHistory.appSessionId, sessionId)))
        .limit(1);
      const msg = msgRows[0];
      if (!msg) return reply.code(404).send({ error: "message_not_found" });

      if (!msg.audioBlobPath) {
        return reply.code(400).send({ error: "no_audio", message: "message has no audio blob" });
      }
      if (msg.transcriptionStatus !== "failed") {
        return reply.code(400).send({
          error: "not_retryable",
          message: `transcription_status is "${msg.transcriptionStatus}", expected "failed"`,
        });
      }

      // Read blob bytes from disk.
      const blobPath = path.join(blobRoot, msg.audioBlobPath);
      let buffer: Buffer;
      try {
        buffer = await fsp.readFile(blobPath);
      } catch (err) {
        logger.warn({ err, msgId, blobPath }, "voice-memo: retry — blob file missing");
        return reply.code(404).send({ error: "blob_missing" });
      }

      // Infer MIME from extension.
      const ext = path.extname(msg.audioBlobPath).toLowerCase();
      const mime =
        ext === ".mp3" ? "audio/mpeg" : ext === ".wav" ? "audio/wav" : "audio/m4a";

      const audio_b64 = buffer.toString("base64");
      const client = wsPool.getOrCreateShared();

      let transcript: string;
      let sttOk: boolean;
      let sttError: string | null = null;

      try {
        const result = await transcribeWithRetry(client, { audio_b64, mime }, STT_TIMEOUT_MS);
        if (!result.success) {
          throw new Error("stt.transcribe returned success=false");
        }
        transcript = result.transcript;
        sttOk = true;
      } catch (err) {
        sttOk = false;
        sttError =
          err instanceof HermesRpcError
            ? `${err.message} (code ${err.code})`
            : err instanceof Error
              ? err.message
              : String(err);
        logger.warn({ err, msgId, sessionId }, "voice-memo: retry STT failed");
        transcript = "";
      }

      // Peaks were stored at original upload time; re-parse from DB for the envelope.
      let retryPeaks: number[] | null = null;
      if (msg.audioPeaksJson) {
        try {
          const parsed = JSON.parse(msg.audioPeaksJson);
          if (Array.isArray(parsed) && parsed.every((v) => typeof v === "number" && isFinite(v))) {
            retryPeaks = parsed as number[];
          }
        } catch {
          // Corrupt peaks — leave null; frontend falls back to plain progress bar.
          logger.warn({ msgId }, "voice-memo: retry — audioPeaksJson failed to parse");
        }
      }

      if (sttOk) {
        await db
          .update(chatHistory)
          .set({
            payloadJson: JSON.stringify({ text: transcript }),
            searchText: transcript,
            transcriptionStatus: "completed",
            transcriptionError: null,
          })
          .where(eq(chatHistory.id, msgId));

        // Forward to Hermes — agent never saw this message during the failed attempt.
        void forwardTranscriptToHermes(db, wsPool, sessionId, transcript, logger);

        return reply.code(200).send({
          message: buildMessageEnvelope({
            id: msg.id,
            content: transcript,
            audioBlobPath: msg.audioBlobPath,
            audioDurationMs: msg.audioDurationMs,
            transcriptionStatus: "completed",
            transcriptionError: null,
            createdAt: msg.createdAt,
            audioPeaks: retryPeaks,
          }),
        });
      } else {
        await db
          .update(chatHistory)
          .set({
            transcriptionStatus: "failed",
            transcriptionError: sttError,
          })
          .where(eq(chatHistory.id, msgId));

        return reply.code(503).send({
          error: "stt_failed",
          message: sttError,
          message_envelope: buildMessageEnvelope({
            id: msg.id,
            content: "",
            audioBlobPath: msg.audioBlobPath,
            audioDurationMs: msg.audioDurationMs,
            transcriptionStatus: "failed",
            transcriptionError: sttError,
            createdAt: msg.createdAt,
            audioPeaks: retryPeaks,
          }),
        });
      }
    },
  );

  // ---------- Route C: GET /voice-blobs/voice/:sha.:ext (auth-gated blob serve) ----------
  //
  // Voice blobs are not tracked in blob_objects and therefore can't go through
  // the signed /blobs/:blobId route. Instead we use a bearer-auth-gated route
  // that verifies the requesting user owns at least one session with an
  // audio_blob_path matching the requested file. This is a lightweight
  // ownership check: any authenticated user who has a chat_history row
  // pointing to the blob is allowed to fetch it — which is always the uploader.

  app.get(
    "/voice-blobs/*",
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = request.user;
      if (!user) return reply.code(401).send({ error: "unauthenticated" });

      // Wildcard path after /voice-blobs/
      const wildcard = (request.params as Record<string, string>)["*"];
      if (!wildcard) return reply.code(400).send({ error: "invalid_path" });

      // Only serve files under voice/
      if (!wildcard.startsWith("voice/")) {
        return reply.code(403).send({ error: "forbidden" });
      }

      // Path traversal guard.
      const normalized = path.posix.normalize(wildcard);
      if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
        return reply.code(403).send({ error: "forbidden" });
      }

      // Ownership: find a chat_history row owned by this user.
      const ownerRows = await db
        .select({ id: chatHistory.id })
        .from(chatHistory)
        .innerJoin(appSessions, eq(chatHistory.appSessionId, appSessions.id))
        .where(
          and(
            eq(chatHistory.audioBlobPath, normalized),
            eq(appSessions.userId, user.id),
          ),
        )
        .limit(1);
      if (!ownerRows[0]) {
        return reply.code(404).send({ error: "not_found" });
      }

      const blobPath = path.join(blobRoot, normalized);
      let fileBuffer: Buffer;
      try {
        fileBuffer = await fsp.readFile(blobPath);
      } catch (err) {
        logger.warn({ err, path: blobPath }, "voice-blob: file missing");
        return reply.code(404).send({ error: "blob_missing" });
      }

      const ext = path.extname(normalized).toLowerCase();
      const contentType =
        ext === ".mp3" ? "audio/mpeg" : ext === ".wav" ? "audio/wav" : "audio/m4a";

      void reply
        .header("content-type", contentType)
        .header("content-length", fileBuffer.byteLength.toString())
        .header("cache-control", "private, max-age=3600");
      return reply.send(fileBuffer);
    },
  );
}
