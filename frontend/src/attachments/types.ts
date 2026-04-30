import type { AttachmentDTO, AttachmentKind } from "../api/types";

// PendingAttachment lifecycle:
//   queued    -> picked, awaiting an upload slot
//   uploading -> in-flight POST /uploads
//   uploaded  -> server returned AttachmentDTO; safe to send
//   failed    -> upload errored; user can retry or remove
//   canceled  -> user removed before upload finished
export type PendingStatus =
  | "queued"
  | "uploading"
  | "uploaded"
  | "failed"
  | "canceled";

// Local input descriptor — produced by pickers, consumed by the upload queue.
// `uri` is a `file://` URI on iOS or a content URI on Android (RN FormData
// accepts both as long as `name` and `type` are present).
export interface LocalFileInput {
  uri: string;
  name: string;
  mime: string;
  kind: AttachmentKind;
  sizeBytes?: number;
}

export interface PendingAttachment {
  // Stable client-side id used for chip keys and queue tracking.
  localId: string;
  appSessionId: string;
  status: PendingStatus;
  input: LocalFileInput;
  // Populated once status === "uploaded".
  attachment: AttachmentDTO | null;
  // Populated once status === "failed".
  error: string | null;
  // Optional progress signal for future use; not wired in Phase 4.
  progress: number;
  createdAt: number;
}
