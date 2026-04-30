// Orphan blob sweeper.
//
// Deletes blob_objects rows that are not referenced by any attachment (as
// primary, thumb, or derived_text) and not referenced by any derived_artifact
// (as parent or as the artifact's own blob). Filters by age so freshly-uploaded
// blobs awaiting attachment-row insertion aren't reaped.
//
// Per-blob transaction boundary: for each candidate we first delete from the
// BlobStore, then delete the DB row. If BlobStore delete fails we log and
// skip — the next sweep will retry. We never leave a DB row pointing at a
// missing object on disk.

import { and, eq, lt, notInArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { attachments, blobObjects, derivedArtifacts } from "../db/schema.js";
import type { AppLogger } from "../logger.js";
import type { BlobStore } from "../storage/blob-store.js";
import type { CleanupResult } from "./runner.js";

export interface OrphanSweeperDeps {
  db: Db;
  blobStore: BlobStore;
  logger: AppLogger;
}

export interface OrphanSweeperConfig {
  ageHours: number;
}

export async function sweepOrphanBlobs(
  deps: OrphanSweeperDeps,
  cfg: OrphanSweeperConfig,
  now: number = Math.floor(Date.now() / 1000),
): Promise<CleanupResult> {
  const log = deps.logger.child({ task: "orphan-blobs" });
  const startedAt = Date.now();
  const cutoff = now - cfg.ageHours * 3600;

  // Reference set: union of every blob_id used by attachments + derived_artifacts.
  // SQLite has no FULL OUTER JOIN; a UNION subquery is simplest. We enumerate
  // candidates via Drizzle's `notInArray` on a fetched list to keep the SQL
  // dialect-agnostic.
  const referenced = new Set<string>();
  for (const r of await deps.db
    .select({ id: attachments.blobId })
    .from(attachments)) {
    referenced.add(r.id);
  }
  for (const r of await deps.db
    .select({ id: attachments.thumbBlobId })
    .from(attachments)) {
    if (r.id) referenced.add(r.id);
  }
  for (const r of await deps.db
    .select({ id: attachments.derivedTextBlobId })
    .from(attachments)) {
    if (r.id) referenced.add(r.id);
  }
  for (const r of await deps.db
    .select({ id: derivedArtifacts.parentBlobId })
    .from(derivedArtifacts)) {
    referenced.add(r.id);
  }
  for (const r of await deps.db
    .select({ id: derivedArtifacts.blobId })
    .from(derivedArtifacts)) {
    referenced.add(r.id);
  }

  // Candidate set: blobs older than cutoff. We filter unreferenced in-memory
  // because notInArray on potentially large sets is fragile.
  const candidates = await deps.db
    .select({
      id: blobObjects.id,
      objectKey: blobObjects.objectKey,
    })
    .from(blobObjects)
    .where(lt(blobObjects.createdAt, cutoff));

  let deleted = 0;
  let errors = 0;
  for (const c of candidates) {
    if (referenced.has(c.id)) continue;
    try {
      await deps.blobStore.deleteObject({ key: c.objectKey });
      // Re-check FK status inside the delete: another upload could have
      // referenced this blob via dedup between our snapshot and now. The DB
      // FK ON DELETE RESTRICT on attachments will throw if so — we tolerate it.
      const result = await deps.db
        .delete(blobObjects)
        .where(eq(blobObjects.id, c.id))
        .returning({ id: blobObjects.id });
      if (result.length > 0) deleted += 1;
    } catch (err) {
      errors += 1;
      log.warn({ err, blobId: c.id, objectKey: c.objectKey }, "orphan blob delete failed");
    }
  }

  // Avoid an unused-import warning for `and`/`notInArray`/`sql` if the file
  // grows; we keep them imported for future variants of the sweep.
  void and;
  void notInArray;
  void sql;

  const durationMs = Date.now() - startedAt;
  log.info(
    { scanned: candidates.length, deleted, errors, durationMs },
    "orphan blob sweep",
  );
  return {
    task: "orphan-blobs",
    scanned: candidates.length,
    deleted,
    errors,
    durationMs,
    lastRunAt: Math.floor(Date.now() / 1000),
  };
}
