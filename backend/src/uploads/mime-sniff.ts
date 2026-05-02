// Phase 7: magic-byte MIME validation.
//
// Cross-checks a multipart upload's declared MIME against a sniffed value
// based on the file's actual magic bytes. The intent is to reject mismatches
// (declared image/jpeg, body is a PDF) and undetectable bodies, since for a
// personal MVP we'd rather refuse a confusing upload than process it.
//
// Rules implemented in `validateDeclaredVsDetected`:
//   - Detected ↔ declared in compatible aliases  -> ok
//   - Declared/Detected disagree                 -> mismatch
//   - Detection returned undefined:
//       text/plain declared -> ok (file-type intentionally cannot detect plain text)
//       anything else       -> undetectable (reject)

import { fileTypeFromBuffer } from "file-type";

export interface SniffResult {
  // Lowercased detected MIME, or null if file-type returned undefined.
  detectedMime: string | null;
  // Detected file extension (lowercased), purely informational.
  detectedExt: string | null;
}

export type MimeValidation =
  | { ok: true; detected: SniffResult }
  | { ok: false; reason: "mismatch"; declared: string; detected: string }
  | { ok: false; reason: "undetectable"; declared: string };

// Aliases group MIMEs that should validate against each other interchangeably.
// e.g. file-type reports image/heif for HEIC samples sometimes; we accept both
// directions of the alias.
const MIME_ALIASES: ReadonlyArray<ReadonlySet<string>> = [
  new Set(["image/heic", "image/heif"]),
  new Set(["image/jpeg", "image/jpg"]),
  // Office Open XML files are zip-based; file-type usually returns the
  // specific mime, but older versions or trimmed builds can return raw zip.
  new Set([
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel.sheet.macroenabled.12",
    "application/zip",
    "application/x-zip-compressed",
  ]),
];

// MIMEs that file-type cannot detect because they have no magic bytes (plain
// text formats). We trust the client's declared type for these — abuse window
// is small since the gateway re-extracts text on the server side anyway.
const UNDETECTABLE_TEXT_MIMES: ReadonlySet<string> = new Set([
  "text/plain",
  "text/csv",
  "application/csv",
  "text/tab-separated-values",
]);

function sameOrAlias(a: string, b: string): boolean {
  if (a === b) return true;
  for (const group of MIME_ALIASES) {
    if (group.has(a) && group.has(b)) return true;
  }
  return false;
}

export async function sniffMime(body: Buffer): Promise<SniffResult> {
  const result = await fileTypeFromBuffer(body);
  if (!result) return { detectedMime: null, detectedExt: null };
  return {
    detectedMime: result.mime.toLowerCase(),
    detectedExt: result.ext.toLowerCase(),
  };
}

export async function validateDeclaredVsDetected(
  body: Buffer,
  declared: string,
): Promise<MimeValidation> {
  const declaredLc = declared.toLowerCase();
  const detected = await sniffMime(body);

  if (detected.detectedMime === null) {
    // file-type cannot detect text formats reliably (no magic bytes).
    const declaredBase = declaredLc.split(";")[0]?.trim() ?? declaredLc;
    if (UNDETECTABLE_TEXT_MIMES.has(declaredBase)) {
      return { ok: true, detected };
    }
    return { ok: false, reason: "undetectable", declared: declaredLc };
  }

  if (sameOrAlias(declaredLc, detected.detectedMime)) {
    return { ok: true, detected };
  }
  return {
    ok: false,
    reason: "mismatch",
    declared: declaredLc,
    detected: detected.detectedMime,
  };
}
