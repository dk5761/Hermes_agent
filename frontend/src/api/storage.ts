/**
 * Storage usage API client.
 *
 * Backend contract (Stage 4 — Agent A):
 *   GET /storage/usage -> StorageUsage
 */
import { apiFetch } from "./client";

export interface StorageTableRow {
  name: string;
  rows: number;
  bytes: number;
}

export interface GatewayDb {
  bytes: number;
  path: string;
  tables: StorageTableRow[];
}

export type BlobKind = "image" | "pdf" | "file" | "derived";

export interface BlobsUsage {
  totalBytes: number;
  byKind: Record<BlobKind, number>;
  objectCount: number;
  /** "local" | "s3" etc. We branch UI on `local`. */
  provider: string;
  root: string;
}

export interface MaterializeCacheUsage {
  bytes: number;
  files: number;
  root: string;
}

export interface StorageUsage {
  gatewayDb: GatewayDb;
  blobs: BlobsUsage;
  materializeCache: MaterializeCacheUsage | null;
}

export async function getStorageUsage(): Promise<StorageUsage> {
  return apiFetch<StorageUsage>("/storage/usage");
}
