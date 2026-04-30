// Cron output -> push notification builder.
//
// =====================================================================
// FRONTEND DEEP-LINK CONTRACT (source of truth — frontend agent reads this)
// =====================================================================
// Expo push notification `data` payload for cron output completions:
//
//   {
//     type: "cron_output",   // discriminator literal
//     jobId: string,         // Hermes cron job id (matches /cron/jobs/:id)
//     outputId: string,      // basename of the .md file (no extension);
//                            //   matches /cron/outputs/:output_id
//   }
//
// Frontend should:
//   - On notification tap, route to a screen that displays cron output
//     `outputId` for `jobId`.
//   - Optionally pre-fetch via GET /cron/outputs/:output_id?job_id=:jobId.
// =====================================================================

import type { PushPayload } from "../push/types.js";

export interface JobMeta {
  jobId: string;
  // Pulled from upstream Hermes /api/cron/jobs/:id.name (best-effort).
  // Falls back to a generic title if Hermes is unavailable.
  name: string | null;
}

export interface OutputSummary {
  outputId: string;
  // First N chars of the markdown file content. We trim/normalize whitespace
  // so the notification body is a single readable line.
  contentPreview: string;
}

const MAX_BODY_CHARS = 80;
const MAX_TITLE_CHARS = 80;

export function buildNotificationFor(
  expoToken: string,
  job: JobMeta,
  output: OutputSummary,
): PushPayload {
  const titleSource = job.name ?? `Cron job ${job.jobId}`;
  const title = truncate(titleSource, MAX_TITLE_CHARS);
  const body =
    output.contentPreview.length > 0
      ? truncate(normalizeWhitespace(output.contentPreview), MAX_BODY_CHARS)
      : "Cron run complete";
  return {
    to: expoToken,
    title,
    body,
    data: {
      type: "cron_output",
      jobId: job.jobId,
      outputId: output.outputId,
    },
  };
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  // -1 to leave space for ellipsis; '…' is a single char so safe.
  return s.slice(0, max - 1).trimEnd() + "…";
}
