import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { AppLogger } from "../logger.js";

export interface MaterializeCacheOptions {
  rootDir: string;
  logger?: AppLogger;
}

// Content-addressed disk cache for materialized remote objects.
// Layout uses a 2-char shard prefix to avoid huge flat dirs on busy buckets.
// In-flight de-dup: concurrent requests for the same key share one fetch.
export class MaterializeCache {
  private readonly rootDir: string;
  private readonly logger: AppLogger | undefined;
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(opts: MaterializeCacheOptions) {
    this.rootDir = path.resolve(opts.rootDir);
    this.logger = opts.logger;
  }

  resolvePath(key: string): string {
    const digest = crypto.createHash("sha256").update(key).digest("hex");
    const shard = digest.slice(0, 2);
    const rest = digest.slice(2);
    return path.join(this.rootDir, shard, rest);
  }

  async has(key: string): Promise<boolean> {
    const target = this.resolvePath(key);
    try {
      const stat = await fsp.stat(target);
      return stat.isFile() && stat.size > 0;
    } catch {
      return false;
    }
  }

  // ensure() returns a final path that contains the object bytes.
  // The fetcher writes into the provided target (a temp file path),
  // and ensure() handles atomic rename + cleanup on error.
  async ensure(key: string, fetcher: (target: string) => Promise<void>): Promise<string> {
    const finalPath = this.resolvePath(key);

    // Fast path: already cached.
    if (await this.has(key)) return finalPath;

    // De-dup concurrent fetches for the same cache path.
    const existing = this.inflight.get(finalPath);
    if (existing) return existing;

    const work = (async (): Promise<string> => {
      // Re-check inside the critical section (another caller may have completed).
      if (await this.has(key)) return finalPath;

      await fsp.mkdir(path.dirname(finalPath), { recursive: true });
      const partial = `${finalPath}.partial-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;

      try {
        await fetcher(partial);
        // fsync the file before rename so a crash doesn't leave a half-written cache hit.
        await fsyncFile(partial);
        await fsp.rename(partial, finalPath);
        return finalPath;
      } catch (err) {
        await safeUnlink(partial);
        throw err;
      }
    })();

    this.inflight.set(finalPath, work);
    try {
      return await work;
    } finally {
      this.inflight.delete(finalPath);
    }
  }
}

async function fsyncFile(p: string): Promise<void> {
  const handle = await fsp.open(p, fs.constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function safeUnlink(p: string): Promise<void> {
  try {
    await fsp.unlink(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // Don't rethrow; we're already on an error path.
    }
  }
}
