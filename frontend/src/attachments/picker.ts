import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
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
    out.push({
      uri: a.uri,
      name: deriveName(a.uri, a.fileName),
      mime,
      kind: "image",
      sizeBytes: a.fileSize,
    });
  }
  return out;
}

export async function pickDocument(): Promise<LocalFileInput[]> {
  const res = await DocumentPicker.getDocumentAsync({
    type: [PDF_MIME],
    multiple: false,
    copyToCacheDirectory: true,
  });
  if (res.canceled) return [];
  const out: LocalFileInput[] = [];
  for (const a of res.assets) {
    const mime = a.mimeType ?? PDF_MIME;
    const kind = kindFromMime(mime);
    if (!kind) {
      throw new PickerError(`Unsupported file type: ${mime}`);
    }
    out.push({
      uri: a.uri,
      name: a.name || "document.pdf",
      mime,
      kind,
      sizeBytes: a.size,
    });
  }
  return out;
}
