// Materialize-cache sweeper.
//
// S3-mode only. Walks the configured cache root and deletes files whose mtime
// is older than `maxAgeDays`. Also removes empty directories left behind so
// the on-disk shape stays bounded over time. Skips silently when the cache
// dir doesn't exist (fresh install).

import fs from "node:fs/promises";
import path from "node:path";
import type { AppLogger } from "../logger.js";
import type { CleanupResult } from "./runner.js";

export interface MaterializeCacheSweeperConfig {
  cacheDir: string;
  maxAgeDays: number;
}

export async function sweepMaterializeCache(
  log: AppLogger,
  cfg: MaterializeCacheSweeperConfig,
  now: number = Date.now(),
): Promise<CleanupResult> {
  const childLog = log.child({ task: "materialize-cache" });
  const startedAt = Date.now();
  const cutoffMs = now - cfg.maxAgeDays * 86_400_000;

  let scanned = 0;
  let deleted = 0;
  let errors = 0;

  try {
    await walkAndPrune(cfg.cacheDir, cutoffMs, {
      onScan: () => {
        scanned += 1;
      },
      onDelete: () => {
        deleted += 1;
      },
      onError: (err, p) => {
        errors += 1;
        childLog.warn({ err, path: p }, "cache prune error");
      },
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Cache dir has never been used. No-op.
    } else {
      errors += 1;
      childLog.warn({ err, dir: cfg.cacheDir }, "cache walk failed");
    }
  }

  const durationMs = Date.now() - startedAt;
  if (deleted > 0 || errors > 0) {
    childLog.info({ scanned, deleted, errors, durationMs }, "materialize cache sweep");
  }
  return {
    task: "materialize-cache",
    scanned,
    deleted,
    errors,
    durationMs,
    lastRunAt: Math.floor(Date.now() / 1000),
  };
}

interface WalkHooks {
  onScan: () => void;
  onDelete: () => void;
  onError: (err: unknown, path: string) => void;
}

// Two-pass: prune files first, then attempt to remove dirs that emptied as a
// result. We re-readdir after file deletion to learn which dirs are empty.
async function walkAndPrune(
  dir: string,
  cutoffMs: number,
  hooks: WalkHooks,
): Promise<boolean> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })) as unknown as import("node:fs").Dirent[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
    hooks.onError(err, dir);
    return false;
  }

  let allRemoved = true;
  for (const entry of entries) {
    const entryName = String(entry.name);
    const full = path.join(dir, entryName);
    if (entry.isDirectory()) {
      const subEmptied = await walkAndPrune(full, cutoffMs, hooks);
      if (subEmptied) {
        try {
          await fs.rmdir(full);
        } catch (err) {
          // ENOTEMPTY is possible if a peer file refused deletion; ignore.
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "ENOTEMPTY" && code !== "ENOENT") {
            hooks.onError(err, full);
          }
          allRemoved = false;
        }
      } else {
        allRemoved = false;
      }
      continue;
    }
    if (!entry.isFile()) {
      allRemoved = false;
      continue;
    }
    hooks.onScan();
    try {
      const stat = await fs.stat(full);
      if (stat.mtimeMs < cutoffMs) {
        await fs.unlink(full);
        hooks.onDelete();
      } else {
        allRemoved = false;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      hooks.onError(err, full);
      allRemoved = false;
    }
  }
  return allRemoved;
}
