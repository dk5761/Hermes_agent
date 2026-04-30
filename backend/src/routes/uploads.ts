import { eq } from "drizzle-orm";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { appSessions, attachments, blobObjects } from "../db/schema.js";
import type { AppLogger } from "../logger.js";
import type { BlobStore } from "../storage/blob-store.js";
import type { SignedUrlSigner } from "../storage/signed-url.js";
import {
  UnsupportedMimeError,
  UploadPipeline,
  loadAttachmentForUser,
} from "../uploads/pipeline.js";
import type { PdfOcrOptions } from "../uploads/pdf.js";
import {
  UploadTooLargeError,
  type UploadLimits,
} from "../uploads/limits.js";
import { validateDeclaredVsDetected } from "../uploads/mime-sniff.js";
import type { ProcessedAttachment, UploadResult } from "../uploads/types.js";

export interface UploadsRoutesDeps {
  db: Db;
  requireAuth: preHandlerHookHandler;
  blobStore: BlobStore;
  signer: SignedUrlSigner;
  signedUrlTtlS: number;
  limits: UploadLimits;
  bodyLimitBytes: number;
  bucket: string;
  logger: AppLogger;
  ocr?: PdfOcrOptions | null;
  // Phase 7: per-user upload rate limit. Keyed by authenticated user id so
  // shared NAT IPs don't penalize each other.
  uploadRateLimit: {
    max: number;
    timeWindowMs: number;
  };
}

const idParams = z.object({ id: z.string().min(1) });

// Multipart form fields are strings; coerce app_session_id at the boundary.
const fieldsSchema = z.object({
  app_session_id: z.string().uuid().optional(),
});

const PREVIEW_CHARS = 400;

export async function registerUploadsRoutes(
  app: FastifyInstance,
  deps: UploadsRoutesDeps,
): Promise<void> {
  const pipeline = new UploadPipeline({
    db: deps.db,
    blobStore: deps.blobStore,
    logger: deps.logger,
    ocr: deps.ocr ?? null,
  });

  app.post(
    "/uploads",
    {
      preHandler: deps.requireAuth,
      bodyLimit: deps.bodyLimitBytes,
      // Per-user limiter; keyGenerator runs after preHandler (requireAuth)
      // so request.user is populated.
      config: {
        rateLimit: {
          max: deps.uploadRateLimit.max,
          timeWindow: deps.uploadRateLimit.timeWindowMs,
          keyGenerator: (req) => req.user?.id ?? req.ip,
        },
      },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) return reply.code(401).send({ error: "unauthenticated" });

      const file = await request.file();
      if (!file) return reply.code(400).send({ error: "missing_file" });

      const rawFields: Record<string, string> = {};
      for (const [k, v] of Object.entries(file.fields)) {
        if (!v || Array.isArray(v)) continue;
        const field = v as { type?: string; value?: unknown };
        if (field.type === "field" && typeof field.value === "string") {
          rawFields[k] = field.value;
        }
      }
      const parsedFields = fieldsSchema.safeParse(rawFields);
      if (!parsedFields.success) {
        return reply.code(400).send({ error: "invalid_fields" });
      }

      let appSessionId: string | null = null;
      if (parsedFields.data.app_session_id) {
        const owned = await deps.db
          .select({ id: appSessions.id })
          .from(appSessions)
          .where(eq(appSessions.id, parsedFields.data.app_session_id))
          .limit(1);
        const ok = owned[0];
        if (!ok) return reply.code(403).send({ error: "session_not_owned" });
        appSessionId = parsedFields.data.app_session_id;
      }

      let body: Buffer;
      try {
        body = await file.toBuffer();
      } catch (err) {
        const e = err as { code?: string };
        if (e.code === "FST_REQ_FILE_TOO_LARGE" || e.code === "FST_FILES_LIMIT") {
          return reply.code(413).send({ error: "payload_too_large" });
        }
        deps.logger.warn({ err }, "multipart read failed");
        return reply.code(400).send({ error: "invalid_multipart" });
      }

      const declaredMime = file.mimetype || "application/octet-stream";
      const originalName = file.filename || null;

      // Phase 7: magic-byte validation. We refuse on declared/detected MIME
      // mismatch and on undetectable bodies (except text/plain, which has no
      // reliable magic). This sits before the pipeline so we never persist a
      // mislabelled blob.
      const mimeCheck = await validateDeclaredVsDetected(body, declaredMime);
      if (!mimeCheck.ok) {
        if (mimeCheck.reason === "mismatch") {
          deps.logger.warn(
            {
              userId: user.id,
              declared: mimeCheck.declared,
              detected: mimeCheck.detected,
              originalName,
            },
            "upload mime mismatch",
          );
          return reply.code(415).send({
            error: "mime_mismatch",
            declared: mimeCheck.declared,
            detected: mimeCheck.detected,
          });
        }
        deps.logger.warn(
          { userId: user.id, declared: mimeCheck.declared, originalName },
          "upload mime undetectable",
        );
        return reply.code(415).send({
          error: "mime_undetectable",
          declared: mimeCheck.declared,
        });
      }

      let processed: ProcessedAttachment;
      try {
        processed = await pipeline.process({
          userId: user.id,
          appSessionId,
          bucket: deps.bucket,
          body,
          declaredMime,
          originalName,
          limits: deps.limits,
        });
      } catch (err) {
        if (err instanceof UnsupportedMimeError) {
          return reply.code(415).send({ error: "unsupported_mime", mime: err.mime });
        }
        if (err instanceof UploadTooLargeError) {
          return reply.code(413).send({
            error: "payload_too_large",
            kind: err.kind,
            limit: err.limit,
            actual: err.actual,
          });
        }
        deps.logger.error({ err }, "upload pipeline failed");
        return reply.code(500).send({ error: "upload_failed" });
      }

      const result: UploadResult = mapProcessed(processed);
      return reply.code(201).send(result);
    },
  );

  app.get(
    "/uploads/:id",
    { preHandler: deps.requireAuth },
    async (request, reply) => {
      const user = request.user;
      if (!user) return reply.code(401).send({ error: "unauthenticated" });
      const params = idParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "invalid_params" });

      const att = await loadAttachmentForUser(deps.db, params.data.id, user.id);
      if (!att) return reply.code(404).send({ error: "not_found" });

      const previewText = att.derivedText
        ? await readSmallBlobAsText(deps.blobStore, att.derivedText.objectKey, PREVIEW_CHARS)
        : null;

      return reply.send({
        id: params.data.id,
        kind: att.kind,
        mime: att.primary.mimeType,
        sizeBytes: att.primary.sizeBytes,
        sha256: att.primary.sha256,
        originalName: att.primary.originalName,
        hasThumb: att.thumb !== null,
        extractedTextPreview: previewText,
        createdAt: att.createdAt,
        hermesReady: att.hermesReady !== null,
      });
    },
  );

  app.get(
    "/uploads/:id/thumb",
    { preHandler: deps.requireAuth },
    async (request, reply) => {
      const user = request.user;
      if (!user) return reply.code(401).send({ error: "unauthenticated" });
      const params = idParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "invalid_params" });

      const att = await loadAttachmentForUser(deps.db, params.data.id, user.id);
      if (!att) return reply.code(404).send({ error: "not_found" });
      if (!att.thumb) return reply.code(404).send({ error: "no_thumb" });

      const built = deps.signer.buildBlobUrl({
        blobId: att.thumb.blobId,
        bucket: att.thumb.bucket,
        expiresInSeconds: deps.signedUrlTtlS,
      });
      return reply.code(302).header("location", built.url).send();
    },
  );
}

function mapProcessed(p: ProcessedAttachment): UploadResult {
  const preview =
    p.extractedText && p.extractedText.length > 0
      ? p.extractedText.slice(0, PREVIEW_CHARS)
      : null;
  // hermesReady semantics per kind:
  //   image -> compressed Hermes-ready derivative exists.
  //   pdf   -> we have extractable text (born-digital OR OCR Phase 4.5) that
  //            the bridge can prepend to the prompt.
  //   file  -> not supported in this phase.
  const hermesReady =
    p.kind === "pdf"
      ? p.derivedText !== null
      : p.hermesReady !== null;
  return {
    id: p.attachmentId,
    kind: p.kind,
    mime: p.primary.mimeType,
    sizeBytes: p.primary.sizeBytes,
    sha256: p.primary.sha256,
    originalName: p.primary.originalName,
    hasThumb: p.thumb !== null,
    extractedTextPreview: preview,
    createdAt: Math.floor(Date.now() / 1000),
    hermesReady,
  };
}

// Used to surface a quick text preview without paging the full extracted blob
// through memory. We rely on the underlying derived blob being small (<=
// configured per-pdf cap), so reading the whole stream is acceptable.
async function readSmallBlobAsText(
  blobStore: BlobStore,
  key: string,
  maxChars: number,
): Promise<string | null> {
  const stream = await blobStore.getObject({ key });
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    chunks.push(chunk);
    total += chunk.byteLength;
    if (total >= maxChars * 4) break;
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text.slice(0, maxChars);
}

// Re-exported for tests / future routes that want to do their own resolution.
export { loadAttachmentForUser };
export { attachments, blobObjects };
