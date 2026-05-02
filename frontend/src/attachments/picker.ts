import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import * as ImageManipulator from "expo-image-manipulator";
import type { LocalFileInput } from "./types";
import type { AttachmentKind } from "../api/types";

// Allowlist mirrors the gateway's accepted MIME set. Any non-allowed MIME is
// converted into a friendly error rather than silently dropped.
const IMAGE_MIMES = new Set<string>([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/gif",
]);
const PDF_MIME = "application/pdf";
// Files that flow through as kind="file" — gateway extracts text on upload.
const FILE_MIMES = new Set<string>([
  "text/csv",
  "application/csv",
  "text/tab-separated-values",
  "text/plain",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel.sheet.macroenabled.12",
]);
const DOCUMENT_PICKER_TYPES = [PDF_MIME, ...FILE_MIMES];

function inferFileMime(uri: string, fallback: string | undefined): string | null {
  if (fallback) {
    const m = fallback.toLowerCase();
    if (m === PDF_MIME || FILE_MIMES.has(m)) return m;
  }
  // Fall back to extension when the OS picker doesn't surface mimeType.
  const lower = uri.toLowerCase().split("?")[0] ?? "";
  if (lower.endsWith(".pdf")) return PDF_MIME;
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".tsv")) return "text/tab-separated-values";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".xlsx"))
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (lower.endsWith(".xlsm"))
    return "application/vnd.ms-excel.sheet.macroenabled.12";
  if (lower.endsWith(".xls")) return "application/vnd.ms-excel";
  return null;
}

export class PickerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PickerError";
  }
}

function inferImageMime(uri: string, fallback: string | undefined): string {
  if (fallback && IMAGE_MIMES.has(fallback)) return fallback;
  // Fall back to extension-based inference; pickers occasionally omit mimeType.
  const lower = uri.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".heic")) return "image/heic";
  if (lower.endsWith(".heif")) return "image/heif";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

function deriveName(uri: string, provided: string | null | undefined): string {
  if (provided && provided.length > 0) return provided;
  const tail = uri.split("/").pop() ?? "image";
  return tail.split("?")[0] || "image";
}

function kindFromMime(mime: string): AttachmentKind | null {
  if (IMAGE_MIMES.has(mime)) return "image";
  if (mime === PDF_MIME) return "pdf";
  if (FILE_MIMES.has(mime)) return "file";
  return null;
}

export async function pickImage(): Promise<LocalFileInput[]> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (perm.status !== "granted") {
    throw new PickerError("Photo library access denied.");
  }
  // Quality 0.85 keeps uploads small while preserving fidelity for vision models.
  const res = await ImagePicker.launchImageLibraryAsync({
    quality: 0.85,
    allowsMultipleSelection: true,
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
  });
  if (res.canceled) return [];
  const out: LocalFileInput[] = [];
  for (const a of res.assets) {
    const mime = inferImageMime(a.uri, a.mimeType);
    if (!IMAGE_MIMES.has(mime)) continue;
    // Re-encode to JPEG: the gateway uses libvips/sharp which lacks the HEIF
    // plugin in our Docker image, so HEIC inputs fail thumbnail + hermes-
    // ready builds upstream. iOS' image picker can return HEIC even when
    // mediaTypes=Images. Forcing JPEG client-side keeps the upload pipeline
    // consistent and shrinks transfer size at the same time.
    const reencoded = await reencodeToJpeg(a.uri).catch(() => null);
    if (reencoded) {
      out.push({
        uri: reencoded.uri,
        name: replaceExt(deriveName(a.uri, a.fileName), "jpg"),
        mime: "image/jpeg",
        kind: "image",
        sizeBytes: reencoded.sizeBytes ?? a.fileSize,
      });
    } else {
      // Fall back to the original asset if the manipulator fails (e.g. format
      // unsupported on this device). The gateway will return a clear error if
      // the upstream still can't process it.
      out.push({
        uri: a.uri,
        name: deriveName(a.uri, a.fileName),
        mime,
        kind: "image",
        sizeBytes: a.fileSize,
      });
    }
  }
  return out;
}

async function reencodeToJpeg(
  uri: string,
): Promise<{ uri: string; sizeBytes?: number } | null> {
  try {
    const result = await ImageManipulator.manipulateAsync(uri, [], {
      compress: 0.85,
      format: ImageManipulator.SaveFormat.JPEG,
    });
    return { uri: result.uri };
  } catch {
    return null;
  }
}

function replaceExt(name: string, newExt: string): string {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  return `${base}.${newExt}`;
}

export async function pickDocument(): Promise<LocalFileInput[]> {
  const res = await DocumentPicker.getDocumentAsync({
    type: DOCUMENT_PICKER_TYPES,
    multiple: false,
    copyToCacheDirectory: true,
  });
  if (res.canceled) return [];
  const out: LocalFileInput[] = [];
  for (const a of res.assets) {
    const mime = inferFileMime(a.uri, a.mimeType ?? undefined) ?? a.mimeType;
    const kind = mime ? kindFromMime(mime) : null;
    if (!mime || !kind) {
      throw new PickerError(`Unsupported file type: ${a.mimeType ?? "unknown"}`);
    }
    out.push({
      uri: a.uri,
      name: a.name || "attachment",
      mime,
      kind,
      sizeBytes: a.size,
    });
  }
  return out;
}
