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

// Phase 4 rejects unknown kinds outright; populate via env in a later phase.
const OTHER_ALLOWED_MIMES: ReadonlySet<string> = new Set();

export function mimeToKind(mime: string): AttachmentKind | null {
  const m = mime.toLowerCase();
  if (IMAGE_MIMES.has(m)) return "image";
  if (PDF_MIMES.has(m)) return "pdf";
  if (OTHER_ALLOWED_MIMES.has(m)) return "file";
  return null;
}

export function isImageMime(mime: string): boolean {
  return IMAGE_MIMES.has(mime.toLowerCase());
}

export function isPdfMime(mime: string): boolean {
  return PDF_MIMES.has(mime.toLowerCase());
}
