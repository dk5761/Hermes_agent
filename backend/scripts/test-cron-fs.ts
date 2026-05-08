/**
 * Smoke test for backend/src/hermes/cron-fs.ts. Run with:
 *   pnpm exec tsx scripts/test-cron-fs.ts
 *
 * Builds a temporary fake HERMES_HOME, drops a few output files across
 * two jobs (one of which has no outputs to verify it is omitted), and
 * asserts that listCronOutputs / listAllJobsOutputSummary / readCronOutput
 * return the expected shape and ordering.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  extractPreview,
  listAllJobsOutputSummary,
  listCronOutputs,
  readCronOutput,
} from "../src/hermes/cron-fs.js";

interface Fixture {
  jobId: string;
  outputId: string;
  content: string;
  mtimeMs: number;
}

const fixtures: Fixture[] = [
  {
    jobId: "job-alpha",
    outputId: "2026-05-01_09-00-00",
    content: "# Standup digest — May 1\n\nFirst real line about the standup.\nSecond line.\n",
    mtimeMs: new Date("2026-05-01T09:00:00Z").getTime(),
  },
  {
    jobId: "job-alpha",
    outputId: "2026-05-08_09-00-00",
    content: "# Standup digest — May 8\n\n- Latest run output line one.\n- Bullet two with extra context.\n",
    mtimeMs: new Date("2026-05-08T09:00:00Z").getTime(),
  },
  {
    jobId: "job-beta",
    outputId: "2026-05-07_18-00-00",
    content: "---\ntitle: cost rollup\n---\n\nWeekly cost rollup — $142.40 across 4 providers, +8% week over week.\n",
    mtimeMs: new Date("2026-05-07T18:00:00Z").getTime(),
  },
];

function assert(condition: unknown, message: string): void {
  if (!condition) {
    console.error("✗ FAIL:", message);
    process.exit(1);
  }
  console.log("✓", message);
}

async function main(): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cron-fs-test-"));
  console.log("temp home:", home);

  // Create an empty job dir to verify it is filtered out.
  await fs.mkdir(path.join(home, "cron", "output", "job-empty"), { recursive: true });

  for (const fx of fixtures) {
    const dir = path.join(home, "cron", "output", fx.jobId);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${fx.outputId}.md`);
    await fs.writeFile(file, fx.content, "utf8");
    await fs.utimes(file, fx.mtimeMs / 1000, fx.mtimeMs / 1000);
  }

  // extractPreview ─────────────────────────────────────────────────────
  const sample = "# heading\n\n- bullet one\n- bullet two\nplain three\n";
  const preview = extractPreview(sample);
  assert(preview === "bullet one — bullet two", `extractPreview joins first 2 non-heading lines, stripped bullets (got: "${preview}")`);

  const fmPreview = extractPreview("---\ntitle: x\n---\n\nactual line\n");
  assert(fmPreview === "actual line", `extractPreview drops YAML frontmatter (got: "${fmPreview}")`);

  // Hermes wraps every cron run in a header before the actual response.
  // The preview should jump past the metadata + Prompt section and pull
  // text from the Response body, not echo "**Job ID:** ...".
  const hermesShaped = [
    "# Cron Job: Daily AI News Digest",
    "",
    "**Job ID:** abc123",
    "**Run Time:** 2026-05-07 10:39:28",
    "**Schedule:** 0 9 * * *",
    "",
    "## Prompt",
    "",
    "Search the web for AI news…",
    "",
    "## Response",
    "",
    "I have enough to compile the digest. Here's the report:",
    "",
    "# 🤖 Daily AI Briefing — May 7, 2026",
    "",
    "OpenAI shipped a new safety paper this morning.",
  ].join("\n");
  const hermesPreview = extractPreview(hermesShaped);
  assert(
    hermesPreview.includes("compile the digest") || hermesPreview.includes("OpenAI"),
    `extractPreview anchors on ## Response, skips metadata + prompt (got: "${hermesPreview}")`,
  );
  assert(
    !hermesPreview.includes("Job ID") && !hermesPreview.includes("Run Time"),
    `extractPreview does NOT echo Hermes metadata lines (got: "${hermesPreview}")`,
  );

  // listCronOutputs ────────────────────────────────────────────────────
  const alphaList = await listCronOutputs(home, "job-alpha");
  assert(alphaList.length === 2, `listCronOutputs returns 2 entries for job-alpha (got: ${alphaList.length})`);
  assert(alphaList[0]?.id === "2026-05-08_09-00-00", "listCronOutputs sorts newest-first");
  assert((alphaList[0]?.preview.length ?? 0) > 0, "listCronOutputs populates preview field");
  assert(typeof alphaList[0]?.sizeBytes === "number" && alphaList[0]!.sizeBytes > 0, "listCronOutputs reports sizeBytes");

  const emptyList = await listCronOutputs(home, "job-empty");
  assert(emptyList.length === 0, "listCronOutputs returns [] for empty job dir");

  const missingList = await listCronOutputs(home, "no-such-job");
  assert(missingList.length === 0, "listCronOutputs returns [] for missing job dir");

  // listAllJobsOutputSummary ───────────────────────────────────────────
  const summary = await listAllJobsOutputSummary(home);
  assert(summary.length === 2, `listAllJobsOutputSummary returns 2 jobs (alpha + beta), excludes empty (got: ${summary.length})`);
  // Newest latest.createdAt first → alpha (May 8) before beta (May 7).
  assert(summary[0]?.jobId === "job-alpha", "listAllJobsOutputSummary sorts by latest.createdAt desc");
  assert(summary[0]?.count === 2, "listAllJobsOutputSummary counts files in the job dir");
  assert(summary[0]?.latest.id === "2026-05-08_09-00-00", "listAllJobsOutputSummary picks newest output as latest");
  assert((summary[0]?.latest.preview.length ?? 0) > 0, "listAllJobsOutputSummary populates latest.preview");
  assert(summary[1]?.jobId === "job-beta", "listAllJobsOutputSummary returns beta second");
  assert(summary[1]?.count === 1, "listAllJobsOutputSummary counts beta correctly");

  // readCronOutput ─────────────────────────────────────────────────────
  const out = await readCronOutput(home, "job-alpha", "2026-05-08_09-00-00");
  assert(out !== null, "readCronOutput returns content for existing output");
  assert(out?.content.includes("Standup digest — May 8"), "readCronOutput returns full file content");
  assert(out?.preview && out.preview.length > 0, "readCronOutput populates preview");

  const missing = await readCronOutput(home, "job-alpha", "no-such-output");
  assert(missing === null, "readCronOutput returns null for missing output");

  // Empty home ─────────────────────────────────────────────────────────
  const emptyHome = await fs.mkdtemp(path.join(os.tmpdir(), "cron-fs-empty-"));
  const emptySummary = await listAllJobsOutputSummary(emptyHome);
  assert(emptySummary.length === 0, "listAllJobsOutputSummary returns [] when home has no cron/output dir");
  await fs.rm(emptyHome, { recursive: true, force: true });

  await fs.rm(home, { recursive: true, force: true });
  console.log("\nAll smoke checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
