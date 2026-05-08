import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export interface CronOutputSummary {
  id: string;
  jobId: string;
  createdAt: string;
  sizeBytes: number;
  preview: string;
}

export interface CronOutput extends CronOutputSummary {
  content: string;
}

export interface JobOutputSummary {
  jobId: string;
  count: number;
  latest: {
    id: string;
    createdAt: string;
    preview: string;
  };
}

// Bytes to read from each output file when computing the list-row preview.
// Hermes wraps every cron run in a header (Job ID / Run Time / Schedule /
// Prompt) before the actual `## Response` payload. The prompt block is
// often 1–3 KB on its own, so we read 8 KB to make sure the response
// preamble is in range. Cost is still trivial (one open + one short read
// per file, scoped to `latest` per job for the by-job aggregator).
const PREVIEW_READ_BYTES = 8192;
const PREVIEW_MAX_CHARS = 160;

// Resolve the configured Hermes data root. Defaults to ~/.hermes per upstream
// (HERMES_CONTRACT.md §"Hermes process"). HERMES_HOME env override exists for
// containerized deployments where Hermes runs under a different home.
export function resolveHermesHome(configured: string | undefined): string {
  if (configured && configured.trim().length > 0) return path.resolve(configured);
  return path.join(os.homedir(), ".hermes");
}

function outputDir(home: string, jobId: string): string {
  return path.join(home, "cron", "output", jobId);
}

// Filename basenames are the canonical output IDs (per HERMES_CONTRACT.md).
// We strip the ".md" extension when exposing via API but accept either form on input.
function normalizeOutputId(id: string): string {
  return id.endsWith(".md") ? id.slice(0, -3) : id;
}

export async function listCronOutputs(
  home: string,
  jobId: string,
): Promise<CronOutputSummary[]> {
  const dir = outputDir(home, jobId);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
  const results: CronOutputSummary[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const full = path.join(dir, name);
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const id = normalizeOutputId(name);
    const preview = await readPreview(full, stat.size);
    results.push({
      id,
      jobId,
      createdAt: new Date(stat.mtimeMs).toISOString(),
      sizeBytes: stat.size,
      preview,
    });
  }
  results.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return results;
}

// Aggregator for the Outputs tab on mobile: one summary row per job that
// has at least one output, sorted newest-first by latest run mtime. Returns
// an empty array if the cron output root does not exist.
//
// Performance: opens ~1KB from the newest file per job to compute the
// preview. With <100 jobs and short reads this is well under 50ms locally.
// Switch to an mtime-keyed cache if profiling shows it.
export async function listAllJobsOutputSummary(
  home: string,
): Promise<JobOutputSummary[]> {
  const root = path.join(home, "cron", "output");
  let dirNames: string[];
  try {
    dirNames = await fs.readdir(root);
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
  const items: JobOutputSummary[] = [];
  for (const jobId of dirNames) {
    const jobDir = path.join(root, jobId);
    let jobStat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      jobStat = await fs.stat(jobDir);
    } catch {
      continue;
    }
    if (!jobStat.isDirectory()) continue;
    let files: string[];
    try {
      files = await fs.readdir(jobDir);
    } catch {
      continue;
    }
    let count = 0;
    let latestPath: string | null = null;
    let latestMtimeMs = -Infinity;
    let latestSize = 0;
    let latestId = "";
    for (const name of files) {
      if (!name.endsWith(".md")) continue;
      const full = path.join(jobDir, name);
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      count += 1;
      if (stat.mtimeMs > latestMtimeMs) {
        latestMtimeMs = stat.mtimeMs;
        latestPath = full;
        latestSize = stat.size;
        latestId = normalizeOutputId(name);
      }
    }
    if (count === 0 || latestPath === null) continue;
    const preview = await readPreview(latestPath, latestSize);
    items.push({
      jobId,
      count,
      latest: {
        id: latestId,
        createdAt: new Date(latestMtimeMs).toISOString(),
        preview,
      },
    });
  }
  items.sort((a, b) =>
    a.latest.createdAt < b.latest.createdAt ? 1 : -1,
  );
  return items;
}

export async function readCronOutput(
  home: string,
  jobId: string,
  outputId: string,
): Promise<CronOutput | null> {
  const id = normalizeOutputId(outputId);
  const full = path.join(outputDir(home, jobId), `${id}.md`);
  try {
    const stat = await fs.stat(full);
    if (!stat.isFile()) return null;
    const content = await fs.readFile(full, "utf8");
    return {
      id,
      jobId,
      createdAt: new Date(stat.mtimeMs).toISOString(),
      sizeBytes: stat.size,
      preview: extractPreview(content),
      content,
    };
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

async function readPreview(filePath: string, fileSize: number): Promise<string> {
  const readLen = Math.min(fileSize, PREVIEW_READ_BYTES);
  if (readLen <= 0) return "";
  let fh: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    fh = await fs.open(filePath, "r");
    const buf = Buffer.alloc(readLen);
    await fh.read(buf, 0, readLen, 0);
    return extractPreview(buf.toString("utf8"));
  } catch {
    return "";
  } finally {
    if (fh) await fh.close().catch(() => undefined);
  }
}

// Strip headings, blank lines, and the Hermes cron-job metadata preamble;
// return up to two content lines joined with " — ", clipped to
// PREVIEW_MAX_CHARS. Used as the row subtitle in the Outputs tab and the
// per-job CronJobOutputs list.
//
// Hermes cron output files have this canonical structure:
//
//   # Cron Job: <name>
//
//   **Job ID:** ...
//   **Run Time:** ...
//   **Schedule:** ...
//
//   ## Prompt
//   <prompt body>
//
//   ## Response
//   <actual run output>
//
// We anchor on the `## Response` heading and pull the preview from there.
// If the heading is absent (e.g. older runs, custom output), we fall back
// to the first non-metadata content line.
export function extractPreview(content: string): string {
  if (!content) return "";
  let body = content;
  // Drop YAML frontmatter if present.
  if (body.startsWith("---")) {
    const end = body.indexOf("\n---", 3);
    if (end !== -1) body = body.slice(end + 4);
  }
  // Anchor on the "## Response" heading when present so we skip the entire
  // Hermes preamble (Job ID / Run Time / Schedule / Prompt). Match
  // case-insensitively and at any heading level (#, ##, ###).
  const responseMatch = body.match(/^#{1,6}\s+response\s*$/im);
  if (responseMatch && typeof responseMatch.index === "number") {
    body = body.slice(responseMatch.index + responseMatch[0].length);
  }
  const lines = body.split(/\r?\n/);
  const picked: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // Skip markdown headings, code fences, horizontal rules.
    if (line.startsWith("#")) continue;
    if (line.startsWith("```")) continue;
    if (line === "---" || line === "***") continue;
    // Skip the Hermes metadata key/value lines — they look like
    // `**Job ID:** abc` / `**Run Time:** 2026-...`. Bold-prefixed lines
    // with a colon in the bold span are almost always metadata, not body.
    if (/^\*\*[^*]+:\*\*/.test(line)) continue;
    // Strip leading bullet / blockquote markers so the preview reads
    // naturally as a sentence.
    let stripped = line.replace(/^[-*+]\s+/, "").replace(/^>\s+/, "");
    // Strip leading bold markers (**foo** body → foo body) so the preview
    // doesn't lead with markdown asterisks.
    stripped = stripped.replace(/^\*\*([^*]+)\*\*\s*/, "$1 ");
    if (!stripped) continue;
    picked.push(stripped);
    if (picked.length >= 2) break;
  }
  let joined = picked.join(" — ");
  if (joined.length > PREVIEW_MAX_CHARS) {
    joined = joined.slice(0, PREVIEW_MAX_CHARS - 1).trimEnd() + "…";
  }
  return joined;
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "ENOENT"
  );
}
