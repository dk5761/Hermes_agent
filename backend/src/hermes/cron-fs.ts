import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export interface CronOutputSummary {
  id: string;
  jobId: string;
  createdAt: string;
  sizeBytes: number;
}

export interface CronOutput extends CronOutputSummary {
  content: string;
}

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
    results.push({
      id,
      jobId,
      createdAt: new Date(stat.mtimeMs).toISOString(),
      sizeBytes: stat.size,
    });
  }
  results.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return results;
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
      content,
    };
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "ENOENT"
  );
}
