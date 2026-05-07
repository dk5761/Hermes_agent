/**
 * voice-orphan-cleanup — startup-time pruner for orphaned audio blobs.
 *
 * When the voice-memo endpoint crashes after writing the blob file but before
 * inserting the chat_history row, the file is left on disk with no DB
 * reference. This module scans `<blobRoot>/voice/` once at boot and unlinks
 * any file that:
 *   1. Has no matching `chat_history.audio_blob_path` row, AND
 *   2. Is older than 24 hours (young files may still be in-flight).
 *
 * Fire-and-forget: call `runVoiceOrphanCleanup` after the server is listening.
 * Errors are logged but never rethrown.
 */

import fsp from "node:fs/promises";
import path from "node:path";
import type { Db } from "../db/client.js";
import { chatHistory } from "../db/schema.js";
import { isNotNull } from "drizzle-orm";
import type { AppLogger } from "../logger.js";

const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Prune orphaned voice blob files that have no matching DB row and are older
 * than 24 hours. Runs once synchronously (from the caller's perspective it is
 * fire-and-forget via `void`).
 *
 * @param db       Drizzle database handle.
 * @param blobRoot Absolute path to the blob root (STORAGE_LOCAL_ROOT).
 * @param logger   Structured logger.
 */
export async function runVoiceOrphanCleanup(
  db: Db,
  blobRoot: string,
  logger: AppLogger,
): Promise<void> {
  const voiceDir = path.join(blobRoot, "voice");

  // Check directory exists before scanning — if no voice memos have ever been
  // sent the directory may not exist yet.
  try {
    await fsp.access(voiceDir);
  } catch {
    logger.info("voice-orphan-cleanup: voice dir does not exist yet, skipping");
    return;
  }

  // Build the set of all referenced paths from the DB.
  let referenced: Set<string>;
  try {
    const rows = await db
      .select({ audioBlobPath: chatHistory.audioBlobPath })
      .from(chatHistory)
      .where(isNotNull(chatHistory.audioBlobPath));

    referenced = new Set(
      rows
        .map((r) => r.audioBlobPath)
        .filter((p): p is string => typeof p === "string"),
    );
  } catch (err) {
    logger.error({ err }, "voice-orphan-cleanup: failed to query DB; aborting");
    return;
  }

  // Scan disk and unlink unreferenced files older than 24h.
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fsp.readdir(voiceDir, { withFileTypes: true });
  } catch (err) {
    logger.error({ err, voiceDir }, "voice-orphan-cleanup: readdir failed; aborting");
    return;
  }

  const cutoff = Date.now() - ORPHAN_AGE_MS;
  let pruned = 0;
  let skipped = 0;
  let errors = 0;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const relKey = `voice/${entry.name}`;
    if (referenced.has(relKey)) continue;

    const filePath = path.join(voiceDir, entry.name);
    let mtime: number;
    try {
      const stat = await fsp.stat(filePath);
      mtime = stat.mtimeMs;
    } catch (err) {
      logger.warn({ err, filePath }, "voice-orphan-cleanup: stat failed; skipping");
      errors++;
      continue;
    }

    if (mtime > cutoff) {
      // File is newer than 24h — may still be in-flight.
      skipped++;
      continue;
    }

    try {
      await fsp.unlink(filePath);
      pruned++;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn({ err, filePath }, "voice-orphan-cleanup: unlink failed");
        errors++;
      }
    }
  }

  logger.info(
    { pruned, skipped, errors, voiceDir },
    "voice-orphan-cleanup: complete",
  );
}
