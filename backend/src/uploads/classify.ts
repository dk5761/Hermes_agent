import type { AttachmentKind } from "./types.js";

// Allowlist documented in HERMES_MOBILE_IMPLEMENTATION_PLAN.md §"Upload Handling".
// HEIC/HEIF accepted because the iOS camera roll yields them; the image
// pipeline will best-effort transcode to JPEG via libvips, falling back to
// "kind: file" semantics if the build lacks HEIF support.
const IMAGE_MIMES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/gif",
]);

const PDF_MIMES: ReadonlySet<string> = new Set(["application/pdf"]);

// CSV / TSV — uploaded as kind=file; pipeline stores the raw bytes as
// derivedText so the bridge can prepend them like a PDF text block.
const CSV_MIMES: ReadonlySet<string> = new Set([
  "text/csv",
  "application/csv",
  "text/tab-separated-values",
  "text/plain",
]);

// Excel (xls/xlsx + Apple Numbers' xlsx export). Pipeline parses to a
// CSV-equivalent text dump and stores that as derivedText.
const SPREADSHEET_MIMES: ReadonlySet<string> = new Set([
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel.sheet.macroenabled.12",
]);

const FILE_MIMES: ReadonlySet<string> = new Set([
  ...CSV_MIMES,
  ...SPREADSHEET_MIMES,
]);

export function mimeToKind(mime: string): AttachmentKind | null {
  const m = mime.toLowerCase();
  if (IMAGE_MIMES.has(m)) return "image";
  if (PDF_MIMES.has(m)) return "pdf";
  if (FILE_MIMES.has(m)) return "file";
  return null;
}

export function isImageMime(mime: string): boolean {
  return IMAGE_MIMES.has(mime.toLowerCase());
}

export function isPdfMime(mime: string): boolean {
  return PDF_MIMES.has(mime.toLowerCase());
}

export function isCsvMime(mime: string): boolean {
  return CSV_MIMES.has(mime.toLowerCase());
}

export function isSpreadsheetMime(mime: string): boolean {
  return SPREADSHEET_MIMES.has(mime.toLowerCase());
}
