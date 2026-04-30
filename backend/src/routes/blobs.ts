import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { blobObjects } from "../db/schema.js";
import type { AppLogger } from "../logger.js";
import type { BlobStore } from "../storage/blob-store.js";
import type { SignedUrlSigner } from "../storage/signed-url.js";

export interface BlobsRoutesDeps {
  db: Db;
  blobStore: BlobStore;
  signer: SignedUrlSigner;
  logger: AppLogger;
}

const idParams = z.object({ blobId: z.string().min(1) });
const querySchema = z.object({
  sig: z.string().min(8),
  exp: z.coerce.number().int().positive(),
});

// Only used in STORAGE_PROVIDER=local mode; S3 returns absolute presigned URLs that bypass the gateway.
export async function registerBlobsRoutes(
  app: FastifyInstance,
  deps: BlobsRoutesDeps,
): Promise<void> {
  // Phase 7: opt out of the global rate limit. Blob fetches are signed
  // (HMAC-protected URLs with their own expiry) and behave like CDN-style
  // traffic — putting the gateway's rate limiter in front of them would
  // throttle attachment thumbnails on busy chat screens.
  app.get("/blobs/:blobId", { config: { rateLimit: false } }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_params" });
    const query = querySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_query" });

    const rows = await deps.db
      .select()
      .from(blobObjects)
      .where(eq(blobObjects.id, params.data.blobId))
      .limit(1);
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: "not_found" });

    const ok = deps.signer.verifyBlobSignature({
      blobId: row.id,
      bucket: row.bucket,
      sig: query.data.sig,
      exp: query.data.exp,
    });
    if (!ok) return reply.code(403).send({ error: "invalid_signature" });

    let stream: NodeJS.ReadableStream;
    try {
      stream = await deps.blobStore.getObject({ key: row.objectKey });
    } catch (err) {
      deps.logger.warn({ err, blobId: row.id }, "blob read failed");
      return reply.code(404).send({ error: "blob_missing" });
    }
    void reply
      .header("content-type", row.mimeType)
      .header("content-length", row.sizeBytes.toString())
      .header("cache-control", "private, max-age=300");
    return reply.send(stream);
  });
}
