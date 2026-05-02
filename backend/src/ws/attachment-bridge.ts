import path from "node:path";
import { promises as fsp } from "node:fs";
import type { Db } from "../db/client.js";
import type { AppLogger } from "../logger.js";
import type { BlobStore } from "../storage/blob-store.js";
import { loadAttachmentForUser, type AttachmentLookupResult } from "../uploads/pipeline.js";

// Hermes' tui_gateway image.attach (cli.py:1303) gates files by **suffix**:
//   {.png .jpg .jpeg .gif .webp .bmp .tiff .tif .svg .ico}
// Our blobs are stored as bare sha256 hashes with no extension, so the
// suffix check fails with code 4016. We compensate by symlinking to a
// sibling name `<sha>.<ext>` derived from the blob's mimeType and handing
// Hermes that path. Symlinks land in the shared bind-mount, so Hermes can
// follow them.
function mimeToImageExt(mime: string): string | null {
  const m = mime.toLowerCase().split(";")[0]?.trim() ?? "";
  switch (m) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/bmp":
      return "bmp";
    case "image/tiff":
      return "tiff";
    case "image/svg+xml":
      return "svg";
    case "image/x-icon":
    case "image/vnd.microsoft.icon":
      return "ico";
    default:
      return null;
  }
}

export interface AttachmentBridgeConfig {
  // Per-PDF cap to keep prompt prefix bounded.
  perPdfBytes: number;
  // Total prefix budget across all attached PDFs.
  totalPrefixBytes: number;
}

export interface ResolvedImageAttachment {
  attachmentId: string;
  localPath: string;
}

export interface AttachmentBridgeResult {
  imagePaths: ResolvedImageAttachment[];
  promptPrefix: string;
  warnings: AttachmentBridgeWarning[];
}

export interface AttachmentBridgeWarning {
  attachmentId: string;
  code:
    | "attachment_not_found"
    | "attachment_unauthorized"
    | "session_mismatch"
    | "pdf_no_text_layer"
    | "pdf_text_read_failed"
    | "image_materialize_failed"
    | "file_no_text_extracted"
    | "file_text_read_failed";
  message: string;
}

export class AttachmentUnauthorizedError extends Error {
  constructor(public readonly attachmentId: string) {
    super(`attachment_unauthorized:${attachmentId}`);
    this.name = "AttachmentUnauthorizedError";
  }
}

export interface BuildAttachmentContextInput {
  userId: string;
  appSessionId: string;
  attachmentIds: readonly string[];
}

export class AttachmentBridge {
  private readonly db: Db;
  private readonly blobStore: BlobStore;
  private readonly log: AppLogger;
  private readonly cfg: AttachmentBridgeConfig;

  constructor(deps: {
    db: Db;
    blobStore: BlobStore;
    logger: AppLogger;
    config: AttachmentBridgeConfig;
  }) {
    this.db = deps.db;
    this.blobStore = deps.blobStore;
    this.log = deps.logger.child({ component: "attachment-bridge" });
    this.cfg = deps.config;
  }

  // Resolve every attachment for chat.send. Throws on first auth violation —
  // gateway should reject the whole frame rather than silently drop attachments.
  async build(input: BuildAttachmentContextInput): Promise<AttachmentBridgeResult> {
    const imagePaths: ResolvedImageAttachment[] = [];
    const warnings: AttachmentBridgeWarning[] = [];
    const pdfBlocks: string[] = [];
    let pdfBudgetRemaining = this.cfg.totalPrefixBytes;

    for (const id of input.attachmentIds) {
      const att = await loadAttachmentForUser(this.db, id, input.userId);
      if (!att) {
        throw new AttachmentUnauthorizedError(id);
      }
      // Ownership check: if attachment was bound to a different app session at
      // upload time, reject the chat.send. NULL session_id means "unbound" and
      // is allowed.
      if (att.appSessionId && att.appSessionId !== input.appSessionId) {
        throw new AttachmentUnauthorizedError(id);
      }

      switch (att.kind) {
        case "image":
          await this.handleImage(id, att, imagePaths, warnings);
          break;
        case "pdf": {
          const block = await this.handlePdf(id, att, pdfBudgetRemaining, warnings);
          if (block) {
            pdfBlocks.push(block.text);
            pdfBudgetRemaining -= block.bytes;
          }
          break;
        }
        case "file": {
          // CSV / Excel — same prompt-prefix shape as PDFs. Pipeline already
          // wrote a derivedText blob containing the extracted text.
          const block = await this.handleFile(id, att, pdfBudgetRemaining, warnings);
          if (block) {
            pdfBlocks.push(block.text);
            pdfBudgetRemaining -= block.bytes;
          }
          break;
        }
      }
    }

    return {
      imagePaths,
      promptPrefix: pdfBlocks.join("\n\n"),
      warnings,
    };
  }

  private async handleImage(
    id: string,
    att: AttachmentLookupResult,
    out: ResolvedImageAttachment[],
    warnings: AttachmentBridgeWarning[],
  ): Promise<void> {
    // Prefer the compressed Hermes-ready derivative; fall back to original if
    // image processing failed (e.g. HEIC on a libvips build without HEIF).
    const target = att.hermesReady ?? att.primary;
    try {
      const localPath = await this.blobStore.materializeLocalFile({ key: target.objectKey });
      // Hermes wants a recognisable image extension on the file path. Create
      // (or reuse) a symlink alongside the bare-sha blob; both are visible
      // in the read-only bind-mount Hermes sees.
      const ext = mimeToImageExt(target.mimeType);
      let attachPath = localPath;
      if (ext) {
        // Hermes' _resolve_attachment_path calls Path.resolve() which
        // strips symlinks back to the bare-sha target (cli.py:1407 →
        // suffix check at :1303 re-trips). Hardlinks would work but
        // Docker-for-Mac's grpcfuse bind-mount silently no-ops them.
        // Plain copy is the reliable cross-platform option; the file is
        // already small (~hundreds of KB after the hermes-ready pass).
        const dir = path.dirname(localPath);
        const linkPath = path.join(dir, `${path.basename(localPath)}.${ext}`);
        try {
          await fsp.copyFile(localPath, linkPath, fsp.constants?.COPYFILE_EXCL ?? 0);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
            this.log.warn({ err, linkPath }, "image extension copy failed");
          }
        }
        attachPath = linkPath;
      }
      out.push({ attachmentId: id, localPath: attachPath });
    } catch (err) {
      this.log.warn({ err, blobId: target.blobId }, "image materialize failed");
      warnings.push({
        attachmentId: id,
        code: "image_materialize_failed",
        message: "could not materialize image for hermes",
      });
    }
  }

  private async handlePdf(
    id: string,
    att: AttachmentLookupResult,
    budget: number,
    warnings: AttachmentBridgeWarning[],
  ): Promise<{ text: string; bytes: number } | null> {
    if (!att.derivedText) {
      warnings.push({
        attachmentId: id,
        code: "pdf_no_text_layer",
        message: "[attached pdf without extractable text]",
      });
      return null;
    }
    if (budget <= 0) return null;
    let raw: string;
    try {
      raw = await readBlobText(this.blobStore, att.derivedText.objectKey);
    } catch (err) {
      this.log.warn({ err, blobId: att.derivedText.blobId }, "pdf text read failed");
      warnings.push({
        attachmentId: id,
        code: "pdf_text_read_failed",
        message: "could not read extracted pdf text",
      });
      return null;
    }
    const perFile = Math.min(this.cfg.perPdfBytes, budget);
    const truncated = raw.length > perFile;
    const slice = truncated ? raw.slice(0, perFile) + "\n[…truncated]" : raw;
    const filename = att.primary.originalName ?? "document.pdf";
    const block = `[attached: ${filename}]\n${slice}`;
    return { text: block, bytes: Buffer.byteLength(block, "utf8") };
  }

  // CSV / Excel attachments. Pipeline already extracted the text on upload
  // and stored it as derivedText, so this is the same shape as handlePdf —
  // we just label the block with the original filename + mime hint so the
  // agent knows what it's looking at.
  private async handleFile(
    id: string,
    att: AttachmentLookupResult,
    budget: number,
    warnings: AttachmentBridgeWarning[],
  ): Promise<{ text: string; bytes: number } | null> {
    if (!att.derivedText) {
      warnings.push({
        attachmentId: id,
        code: "file_no_text_extracted",
        message: "[attached file with no extractable text]",
      });
      return null;
    }
    if (budget <= 0) return null;
    let raw: string;
    try {
      raw = await readBlobText(this.blobStore, att.derivedText.objectKey);
    } catch (err) {
      this.log.warn({ err, blobId: att.derivedText.blobId }, "file text read failed");
      warnings.push({
        attachmentId: id,
        code: "file_text_read_failed",
        message: "could not read extracted file text",
      });
      return null;
    }
    const perFile = Math.min(this.cfg.perPdfBytes, budget);
    const truncated = raw.length > perFile;
    const slice = truncated ? raw.slice(0, perFile) + "\n[…truncated]" : raw;
    const filename = att.primary.originalName ?? "file";
    const mimeLabel = att.primary.mimeType.split(";")[0]?.trim() ?? "file";
    const block = `[attached: ${filename} (${mimeLabel})]\n${slice}`;
    return { text: block, bytes: Buffer.byteLength(block, "utf8") };
  }
}

async function readBlobText(blobStore: BlobStore, key: string): Promise<string> {
  const stream = await blobStore.getObject({ key });
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
