import type { AttachmentKind } from "./types.js";

export interface UploadLimits {
  imageBytes: number;
  pdfBytes: number;
  otherBytes: number;
}

export class UploadTooLargeError extends Error {
  constructor(
    public readonly kind: AttachmentKind,
    public readonly limit: number,
    public readonly actual: number,
  ) {
    super(`upload_too_large:${kind}:${actual}>${limit}`);
    this.name = "UploadTooLargeError";
  }
}

export function checkSizeForKind(kind: AttachmentKind, bytes: number, limits: UploadLimits): void {
  const limit = limitForKind(kind, limits);
  if (bytes > limit) throw new UploadTooLargeError(kind, limit, bytes);
}

export function limitForKind(kind: AttachmentKind, limits: UploadLimits): number {
  switch (kind) {
    case "image":
      return limits.imageBytes;
    case "pdf":
      return limits.pdfBytes;
    case "file":
      return limits.otherBytes;
  }
}
