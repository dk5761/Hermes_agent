import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { attachments, blobObjects, derivedArtifacts } from "../db/schema.js";
import type { AppLogger } from "../logger.js";
import type { BlobStore } from "../storage/blob-store.js";
import { buildObjectKey } from "../storage/keys.js";
import { isCsvMime, isSpreadsheetMime, mimeToKind } from "./classify.js";
import { buildHermesReady, buildThumbnail } from "./image.js";
import { extractText, type PdfOcrOptions } from "./pdf.js";
import { csvToText, spreadsheetToText } from "./spreadsheet.js";
import { checkSizeForKind, type UploadLimits } from "./limits.js";
import type {
  AttachmentKind,
  PersistedBlob,
  ProcessedAttachment,
} from "./types.js";

export interface ProcessUploadInput {
  userId: string;
  appSessionId: string | null;
  bucket: string;
  body: Buffer;
  declaredMime: string;
  originalName: string | null;
  limits: UploadLimits;
}

export interface UploadPipelineDeps {
  db: Db;
  blobStore: BlobStore;
  logger: AppLogger;
  // Phase 4.5: scanned-PDF OCR. Pass null/undefined to disable.
  ocr?: PdfOcrOptions | null;
}

export class UnsupportedMimeError extends Error {
  constructor(public readonly mime: string) {
    super(`unsupported_mime:${mime}`);
    this.name = "UnsupportedMimeError";
  }
}

export class UploadPipeline {
  private readonly db: Db;
  private readonly blobStore: BlobStore;
  private readonly log: AppLogger;
  private readonly ocr: PdfOcrOptions | null;

  constructor(deps: UploadPipelineDeps) {
    this.db = deps.db;
    this.blobStore = deps.blobStore;
    this.log = deps.logger.child({ component: "upload-pipeline" });
    this.ocr = deps.ocr ?? null;
  }

  async process(input: ProcessUploadInput): Promise<ProcessedAttachment> {
    const kind = mimeToKind(input.declaredMime);
    if (!kind) throw new UnsupportedMimeError(input.declaredMime);
    checkSizeForKind(kind, input.body.byteLength, input.limits);

    const sha256 = crypto.createHash("sha256").update(input.body).digest("hex");
    const primary = await this.persistBlob({
      userId: input.userId,
      bucket: input.bucket,
      body: input.body,
      mimeType: input.declaredMime,
      originalName: input.originalName,
      sha256,
    });

    const warnings: string[] = [];
    let thumb: PersistedBlob | null = null;
    let derivedText: PersistedBlob | null = null;
    let hermesReady: PersistedBlob | null = null;
    let extractedText: string | null = null;
    let pageCount: number | null = null;
    let hasTextLayer: boolean | null = null;
    let ocrUsed = false;

    if (kind === "image") {
      try {
        const t = await buildThumbnail(input.body);
        thumb = await this.persistDerivative({
          userId: input.userId,
          bucket: input.bucket,
          parentBlobId: primary.blobId,
          buffer: t.buffer,
          mimeType: t.mimeType,
          kind: "thumb",
          metaJson: JSON.stringify({ width: t.width, height: t.height }),
        });
      } catch (err) {
        // libvips may reject HEIC/HEIF on builds without HEIF support.
        warnings.push("thumb_build_failed");
        this.log.warn({ err, mime: input.declaredMime }, "thumb build failed");
      }

      try {
        const h = await buildHermesReady(input.body);
        hermesReady = await this.persistDerivative({
          userId: input.userId,
          bucket: input.bucket,
          parentBlobId: primary.blobId,
          buffer: h.buffer,
          mimeType: h.mimeType,
          kind: "hermes_ready",
          metaJson: JSON.stringify({ width: h.width, height: h.height }),
        });
      } catch (err) {
        warnings.push("hermes_ready_build_failed");
        this.log.warn({ err, mime: input.declaredMime }, "hermes-ready build failed");
      }
    } else if (kind === "pdf") {
      try {
        const r = await extractText(input.body, {
          ocr: this.ocr,
          logger: this.log,
        });
        pageCount = r.pageCount;
        hasTextLayer = r.hasTextLayer;
        ocrUsed = r.ocrUsed;
        if (r.text.length > 0) {
          extractedText = r.text;
          // Phase 4.5: distinguish OCR-derived text from born-digital text by
          // derivative kind. The bridge accepts both. Storing exactly one
          // derivative per PDF avoids ambiguity at lookup time.
          const derivedKind = r.ocrUsed ? "ocr_text" : "extracted_text";
          const meta: Record<string, unknown> = {
            pageCount: r.pageCount,
            hasTextLayer: r.hasTextLayer,
          };
          if (r.ocrUsed) {
            meta.ocr = {
              truncated: r.ocrTruncated ?? false,
              pagesProcessed: r.ocrPagesProcessed ?? 0,
            };
          }
          derivedText = await this.persistDerivative({
            userId: input.userId,
            bucket: input.bucket,
            parentBlobId: primary.blobId,
            buffer: Buffer.from(r.text, "utf8"),
            mimeType: "text/plain; charset=utf-8",
            kind: derivedKind,
            metaJson: JSON.stringify(meta),
          });
        } else {
          warnings.push("pdf_no_text_layer");
        }
      } catch (err) {
        warnings.push("pdf_extract_failed");
        this.log.warn({ err }, "pdf text extraction failed");
      }
    } else if (kind === "file") {
      // CSV / Excel → derived text. Agent reads the prepended block from
      // chat.send via the same prompt-prefix path PDFs use.
      try {
        let text: string | null = null;
        if (isCsvMime(input.declaredMime)) text = csvToText(input.body);
        else if (isSpreadsheetMime(input.declaredMime)) text = spreadsheetToText(input.body);
        if (text && text.trim().length > 0) {
          extractedText = text;
          derivedText = await this.persistDerivative({
            userId: input.userId,
            bucket: input.bucket,
            parentBlobId: primary.blobId,
            buffer: Buffer.from(text, "utf8"),
            mimeType: "text/plain; charset=utf-8",
            kind: "extracted_text",
            metaJson: JSON.stringify({ sourceMime: input.declaredMime }),
          });
        } else {
          warnings.push("file_no_text_extracted");
        }
      } catch (err) {
        warnings.push("file_extract_failed");
        this.log.warn({ err, mime: input.declaredMime }, "file text extraction failed");
      }
    }

    const attachmentId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    await this.db.insert(attachments).values({
      id: attachmentId,
      appSessionId: input.appSessionId,
      blobId: primary.blobId,
      kind,
      thumbBlobId: thumb?.blobId ?? null,
      derivedTextBlobId: derivedText?.blobId ?? null,
      createdAt: now,
    });

    return {
      attachmentId,
      kind,
      primary,
      thumb,
      derivedText,
      hermesReady,
      extractedText,
      pageCount,
      hasTextLayer,
      ocrUsed,
      warnings,
    };
  }

  // Dedup at the (user, sha256) granularity. Cross-user dedup is intentionally
  // disabled: it would leak existence of one user's upload to another via
  // SHA-256 collision probes.
  private async persistBlob(params: {
    userId: string;
    bucket: string;
    body: Buffer;
    mimeType: string;
    originalName: string | null;
    sha256: string;
  }): Promise<PersistedBlob> {
    const existing = await this.db
      .select()
      .from(blobObjects)
      .where(and(eq(blobObjects.userId, params.userId), eq(blobObjects.sha256, params.sha256)))
      .limit(1);
    const hit = existing[0];
    if (hit) {
      return {
        blobId: hit.id,
        bucket: hit.bucket,
        objectKey: hit.objectKey,
        sha256: hit.sha256,
        mimeType: hit.mimeType,
        sizeBytes: hit.sizeBytes,
        originalName: hit.originalName,
      };
    }
    const blobId = crypto.randomUUID();
    const objectKey = buildObjectKey({ userId: params.userId, sha256: params.sha256 });
    await this.blobStore.putObject({
      key: objectKey,
      body: params.body,
      mimeType: params.mimeType,
    });
    const now = Math.floor(Date.now() / 1000);
    await this.db.insert(blobObjects).values({
      id: blobId,
      bucket: params.bucket,
      objectKey,
      sha256: params.sha256,
      mimeType: params.mimeType,
      sizeBytes: params.body.byteLength,
      originalName: params.originalName,
      userId: params.userId,
      createdAt: now,
    });
    return {
      blobId,
      bucket: params.bucket,
      objectKey,
      sha256: params.sha256,
      mimeType: params.mimeType,
      sizeBytes: params.body.byteLength,
      originalName: params.originalName,
    };
  }

  // Derivatives are content-addressed by their own sha256 so re-uploading the
  // same image yields identical derivative rows. Keys live under a `derived/`
  // prefix to distinguish them in the local FS layout.
  private async persistDerivative(params: {
    userId: string;
    bucket: string;
    parentBlobId: string;
    buffer: Buffer;
    mimeType: string;
    kind: string;
    metaJson: string | null;
  }): Promise<PersistedBlob> {
    const sha256 = crypto.createHash("sha256").update(params.buffer).digest("hex");
    const blob = await this.persistBlob({
      userId: params.userId,
      bucket: params.bucket,
      body: params.buffer,
      mimeType: params.mimeType,
      originalName: null,
      sha256,
    });
    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    await this.db.insert(derivedArtifacts).values({
      id,
      parentBlobId: params.parentBlobId,
      kind: params.kind,
      blobId: blob.blobId,
      metaJson: params.metaJson,
      createdAt: now,
    });
    return blob;
  }
}

export interface AttachmentLookupResult {
  kind: AttachmentKind;
  primary: PersistedBlob;
  thumb: PersistedBlob | null;
  derivedText: PersistedBlob | null;
  hermesReady: PersistedBlob | null;
  appSessionId: string | null;
  createdAt: number;
}

export async function loadAttachmentForUser(
  db: Db,
  attachmentId: string,
  userId: string,
): Promise<AttachmentLookupResult | null> {
  const rows = await db
    .select({
      attachmentId: attachments.id,
      kind: attachments.kind,
      appSessionId: attachments.appSessionId,
      createdAt: attachments.createdAt,
      primaryBlobId: attachments.blobId,
      thumbBlobId: attachments.thumbBlobId,
      derivedTextBlobId: attachments.derivedTextBlobId,
      blobUserId: blobObjects.userId,
      blobBucket: blobObjects.bucket,
      blobObjectKey: blobObjects.objectKey,
      blobSha256: blobObjects.sha256,
      blobMimeType: blobObjects.mimeType,
      blobSizeBytes: blobObjects.sizeBytes,
      blobOriginalName: blobObjects.originalName,
    })
    .from(attachments)
    .innerJoin(blobObjects, eq(attachments.blobId, blobObjects.id))
    .where(eq(attachments.id, attachmentId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.blobUserId !== userId) return null;

  const primary: PersistedBlob = {
    blobId: row.primaryBlobId,
    bucket: row.blobBucket,
    objectKey: row.blobObjectKey,
    sha256: row.blobSha256,
    mimeType: row.blobMimeType,
    sizeBytes: row.blobSizeBytes,
    originalName: row.blobOriginalName,
  };

  const thumb = row.thumbBlobId ? await loadBlobById(db, row.thumbBlobId) : null;
  // Prefer the FK on attachments (set at upload time). Phase 4.5 also persists
  // the text blob under derived_artifacts(kind in {extracted_text, ocr_text})
  // so future code paths can resolve PDF text without consulting attachments.
  let derivedText: PersistedBlob | null = row.derivedTextBlobId
    ? await loadBlobById(db, row.derivedTextBlobId)
    : null;
  if (!derivedText) {
    derivedText = await loadPdfTextDerivative(db, primary.blobId);
  }
  const hermesReady = await loadHermesReadyDerivative(db, primary.blobId);

  return {
    kind: row.kind as AttachmentKind,
    primary,
    thumb,
    derivedText,
    hermesReady,
    appSessionId: row.appSessionId,
    createdAt: row.createdAt,
  };
}

// Look up the PDF text derivative by kind. Prefer `extracted_text` over
// `ocr_text` if both somehow exist for the same parent blob (shouldn't happen
// — pipeline writes exactly one — but defend against it). Returns null if no
// matching derivative is registered.
async function loadPdfTextDerivative(
  db: Db,
  parentBlobId: string,
): Promise<PersistedBlob | null> {
  const rows = await db
    .select({ kind: derivedArtifacts.kind, blobId: derivedArtifacts.blobId })
    .from(derivedArtifacts)
    .where(eq(derivedArtifacts.parentBlobId, parentBlobId));
  let chosen: string | null = null;
  for (const r of rows) {
    if (r.kind === "extracted_text") {
      chosen = r.blobId;
      break;
    }
    if (r.kind === "ocr_text" && chosen === null) chosen = r.blobId;
  }
  if (!chosen) return null;
  return loadBlobById(db, chosen);
}

export async function loadBlobById(db: Db, blobId: string): Promise<PersistedBlob | null> {
  const rows = await db.select().from(blobObjects).where(eq(blobObjects.id, blobId)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    blobId: row.id,
    bucket: row.bucket,
    objectKey: row.objectKey,
    sha256: row.sha256,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    originalName: row.originalName,
  };
}

async function loadHermesReadyDerivative(
  db: Db,
  parentBlobId: string,
): Promise<PersistedBlob | null> {
  const rows = await db
    .select({ blobId: derivedArtifacts.blobId })
    .from(derivedArtifacts)
    .where(
      and(eq(derivedArtifacts.parentBlobId, parentBlobId), eq(derivedArtifacts.kind, "hermes_ready")),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return loadBlobById(db, row.blobId);
}
