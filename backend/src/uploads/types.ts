export type AttachmentKind = "image" | "pdf" | "file";

export interface PersistedBlob {
  blobId: string;
  bucket: string;
  objectKey: string;
  sha256: string;
  mimeType: string;
  sizeBytes: number;
  originalName: string | null;
}

export interface ProcessedAttachment {
  attachmentId: string;
  kind: AttachmentKind;
  primary: PersistedBlob;
  thumb: PersistedBlob | null;
  derivedText: PersistedBlob | null;
  hermesReady: PersistedBlob | null;
  extractedText: string | null;
  pageCount: number | null;
  hasTextLayer: boolean | null;
  // True when the text was produced by OCR (Phase 4.5) rather than the PDF's
  // own text layer. Used by the upload route to surface a separate signal in
  // the response payload if needed.
  ocrUsed: boolean;
  warnings: string[];
}

export interface UploadResult {
  id: string;
  kind: AttachmentKind;
  mime: string;
  sizeBytes: number;
  sha256: string;
  originalName: string | null;
  hasThumb: boolean;
  extractedTextPreview: string | null;
  createdAt: number;
  hermesReady: boolean;
}
