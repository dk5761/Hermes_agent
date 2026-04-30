import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import type { AppConfig } from "../config.js";
import type { DbHandle } from "../db/client.js";
import type { AppLogger } from "../logger.js";

export interface StorageRoutesDeps {
  config: AppConfig;
  requireAuth: preHandlerHookHandler;
  dbHandle: DbHandle;
  logger: AppLogger;
}

interface TableInfo {
  name: string;
  rows: number;
  bytes: number | null;
}

interface BlobsByKind {
  image: number;
  pdf: number;
  file: number;
  derived: number;
}

interface UsageResponse {
  gatewayDb: { bytes: number; path: string; tables: TableInfo[] };
  blobs: {
    totalBytes: number;
    byKind: BlobsByKind;
    objectCount: number;
    provider: "local" | "s3";
    root: string | null;
  };
  materializeCache: { bytes: number; files: number; root: string | null } | null;
}

export async function registerStorageRoutes(
  app: FastifyInstance,
  deps: StorageRoutesDeps,
): Promise<void> {
  const { config, requireAuth, dbHandle, logger } = deps;

  app.get("/storage/usage", { preHandler: requireAuth }, async (_req, reply) => {
    const dbBytes = await safeFileSize(config.DATABASE_URL);
    const tables = collectTableStats(dbHandle, logger);

    const blobs = collectBlobStats(dbHandle, logger);

    let blobsRoot: string | null = null;
    let blobsTotalDisk: number | null = null;
    if (config.STORAGE_PROVIDER === "local") {
      blobsRoot = path.resolve(config.STORAGE_LOCAL_ROOT);
      // Walk the filesystem to surface physical disk usage. If the DB and FS
      // disagree (orphans / missing files), the on-disk number is what
      // actually matters for "are we full?".
      try {
        const walked = await walkDir(blobsRoot);
        blobsTotalDisk = walked.bytes;
      } catch (err) {
        logger.warn({ err, root: blobsRoot }, "failed to walk local blob root");
      }
    }

    let materializeCache: UsageResponse["materializeCache"] = null;
    if (config.STORAGE_PROVIDER === "s3") {
      const root = path.resolve(config.STORAGE_S3_CACHE_DIR);
      try {
        const walked = await walkDir(root);
        materializeCache = { bytes: walked.bytes, files: walked.files, root };
      } catch (err) {
        logger.debug({ err, root }, "materialize cache root not present yet");
        materializeCache = { bytes: 0, files: 0, root };
      }
    }

    const response: UsageResponse = {
      gatewayDb: {
        bytes: dbBytes,
        path: path.resolve(config.DATABASE_URL),
        tables,
      },
      blobs: {
        // Prefer on-disk bytes for local; fall back to DB-tracked sum.
        totalBytes: blobsTotalDisk ?? blobs.totalBytes,
        byKind: blobs.byKind,
        objectCount: blobs.objectCount,
        provider: config.STORAGE_PROVIDER,
        root: blobsRoot,
      },
      materializeCache,
    };
    return reply.send(response);
  });
}

// ---------------------------------------------------------------------------
// SQLite stats
// ---------------------------------------------------------------------------

function collectTableStats(dbHandle: DbHandle, log: AppLogger): TableInfo[] {
  const out: TableInfo[] = [];
  let names: string[] = [];
  try {
    const rows = dbHandle.raw
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type='table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    names = rows.map((r) => r.name);
  } catch (err) {
    log.warn({ err }, "failed to enumerate sqlite tables");
    return out;
  }

  // Try dbstat virtual table — only available if SQLite was built with
  // SQLITE_ENABLE_DBSTAT_VTAB. better-sqlite3 typically has it. If absent,
  // we surface bytes=null per the contract.
  let dbstatAvailable = false;
  try {
    dbHandle.raw.prepare(`SELECT name FROM dbstat WHERE 0`).get();
    dbstatAvailable = true;
  } catch {
    dbstatAvailable = false;
  }

  for (const name of names) {
    let rows = 0;
    try {
      const r = dbHandle.raw
        .prepare(`SELECT COUNT(*) as c FROM "${name.replace(/"/g, '""')}"`)
        .get() as { c: number };
      rows = r.c;
    } catch (err) {
      log.debug({ err, name }, "failed to count rows for table");
    }
    let bytes: number | null = null;
    if (dbstatAvailable) {
      try {
        const r = dbHandle.raw
          .prepare(`SELECT SUM(pgsize) as b FROM dbstat WHERE name = ?`)
          .get(name) as { b: number | null };
        bytes = typeof r.b === "number" ? r.b : null;
      } catch {
        bytes = null;
      }
    }
    out.push({ name, rows, bytes });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Blob stats (DB-tracked)
// ---------------------------------------------------------------------------

interface BlobStats {
  totalBytes: number;
  objectCount: number;
  byKind: BlobsByKind;
}

function collectBlobStats(dbHandle: DbHandle, log: AppLogger): BlobStats {
  let totalBytes = 0;
  let objectCount = 0;
  try {
    const r = dbHandle.raw
      .prepare(`SELECT IFNULL(SUM(size_bytes), 0) as b, COUNT(*) as c FROM blob_objects`)
      .get() as { b: number; c: number };
    totalBytes = r.b ?? 0;
    objectCount = r.c ?? 0;
  } catch (err) {
    log.warn({ err }, "failed to sum blob_objects");
  }
  const byKind: BlobsByKind = { image: 0, pdf: 0, file: 0, derived: 0 };
  try {
    // Each attachment kind sums via its blob_id. Derived artifacts live in a
    // separate table — sum those independently and surface as `derived`.
    const rows = dbHandle.raw
      .prepare(
        `SELECT a.kind as k, IFNULL(SUM(b.size_bytes), 0) as bytes
         FROM attachments a
         JOIN blob_objects b ON b.id = a.blob_id
         GROUP BY a.kind`,
      )
      .all() as Array<{ k: string; bytes: number }>;
    for (const r of rows) {
      const v = typeof r.bytes === "number" ? r.bytes : 0;
      if (r.k === "image") byKind.image += v;
      else if (r.k === "pdf") byKind.pdf += v;
      else byKind.file += v;
    }
  } catch (err) {
    log.warn({ err }, "failed to group attachment sizes by kind");
  }
  try {
    const r = dbHandle.raw
      .prepare(
        `SELECT IFNULL(SUM(b.size_bytes), 0) as bytes
         FROM derived_artifacts d
         JOIN blob_objects b ON b.id = d.blob_id`,
      )
      .get() as { bytes: number };
    byKind.derived = typeof r.bytes === "number" ? r.bytes : 0;
  } catch (err) {
    log.warn({ err }, "failed to sum derived artifact sizes");
  }
  return { totalBytes, objectCount, byKind };
}

// ---------------------------------------------------------------------------
// Filesystem walk (bounded, defensive)
// ---------------------------------------------------------------------------

async function safeFileSize(p: string): Promise<number> {
  try {
    const s = await fs.stat(path.resolve(p));
    return s.size;
  } catch {
    return 0;
  }
}

async function walkDir(root: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  // Iterative DFS to avoid stack-blowup on deep dirs.
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile()) {
        try {
          const s = await fs.stat(full);
          bytes += s.size;
          files += 1;
        } catch {
          // Skip files we can't stat (race conditions during cleanup).
        }
      }
    }
  }
  return { bytes, files };
}
