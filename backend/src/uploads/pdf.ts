import { PDFParse } from "pdf-parse";
import type { AppLogger } from "../logger.js";
import {
  hasOcrToolchain,
  OcrToolError,
  runScannedPdfOcr,
  type OcrOptions,
} from "./ocr.js";

export interface PdfExtractionResult {
  text: string;
  pageCount: number;
  hasTextLayer: boolean;
  // True iff the text was produced by tesseract OCR rather than the PDF's
  // own text layer. Pipeline uses this to decide which derived_artifact kind
  // to write (`ocr_text` vs `pdf_text`).
  ocrUsed: boolean;
  // Per-OCR run signal, set when present. We keep these optional so
  // born-digital callers don't need to populate them.
  ocrTruncated?: boolean;
  ocrPagesProcessed?: number;
}

export interface PdfExtractOptions {
  ocr: PdfOcrOptions | null;
  logger: AppLogger;
}

export interface PdfOcrOptions {
  enabled: boolean;
  pdftoppmBin: string;
  tesseractBin: string;
  maxPages: number;
  dpi: number;
  timeoutMs: number;
  languages: string;
}

// Born-digital PDF extraction with optional scanned-PDF OCR fallback. When the
// PDF has no extractable text layer and OCR is enabled, rasterizes the first N
// pages and runs tesseract over them. The returned `ocrUsed` flag tells the
// pipeline whether to persist the text under the `ocr_text` derivative kind.
export async function extractText(
  input: Buffer,
  opts: PdfExtractOptions,
): Promise<PdfExtractionResult> {
  // pdfjs-dist transfers ownership of TypedArrays it loads — copy the buffer
  // into a fresh Uint8Array so the upstream caller's buffer stays usable.
  const data = new Uint8Array(input);
  const parser = new PDFParse({ data });
  let bornDigital: { text: string; pageCount: number };
  try {
    const result = await parser.getText();
    const text = (result.text ?? "").trim();
    const pageCount = result.total ?? result.pages?.length ?? 0;
    bornDigital = { text, pageCount };
  } finally {
    await parser.destroy().catch(() => undefined);
  }

  if (bornDigital.text.length > 0) {
    return {
      text: bornDigital.text,
      pageCount: bornDigital.pageCount,
      hasTextLayer: true,
      ocrUsed: false,
    };
  }

  const ocr = opts.ocr;
  if (!ocr || !ocr.enabled) {
    return {
      text: "",
      pageCount: bornDigital.pageCount,
      hasTextLayer: false,
      ocrUsed: false,
    };
  }

  const toolchainOk = await hasOcrToolchain({
    pdftoppmBin: ocr.pdftoppmBin,
    tesseractBin: ocr.tesseractBin,
    logger: opts.logger,
  });
  if (!toolchainOk) {
    return {
      text: "",
      pageCount: bornDigital.pageCount,
      hasTextLayer: false,
      ocrUsed: false,
    };
  }

  try {
    const ocrOpts: OcrOptions = {
      pdftoppmBin: ocr.pdftoppmBin,
      tesseractBin: ocr.tesseractBin,
      maxPages: ocr.maxPages,
      dpi: ocr.dpi,
      timeoutMs: ocr.timeoutMs,
      languages: ocr.languages,
      logger: opts.logger,
    };
    const result = await runScannedPdfOcr(input, ocrOpts);
    const trimmed = result.text.trim();
    if (trimmed.length === 0) {
      return {
        text: "",
        pageCount: result.pageCount || bornDigital.pageCount,
        hasTextLayer: false,
        ocrUsed: false,
        ocrTruncated: result.truncated,
        ocrPagesProcessed: result.pagesProcessed,
      };
    }
    return {
      text: trimmed,
      pageCount: result.pageCount || bornDigital.pageCount,
      hasTextLayer: false,
      ocrUsed: true,
      ocrTruncated: result.truncated,
      ocrPagesProcessed: result.pagesProcessed,
    };
  } catch (err) {
    if (err instanceof OcrToolError) {
      // Toolchain ran but failed on this PDF (corrupt, unsupported, timed out).
      // Don't bubble — best-effort. Caller still gets hasTextLayer:false and
      // attaches the original PDF without text.
      return {
        text: "",
        pageCount: bornDigital.pageCount,
        hasTextLayer: false,
        ocrUsed: false,
      };
    }
    throw err;
  }
}
