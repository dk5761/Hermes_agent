import { apiFetch } from "./client";
import type {
  CronJob,
  CronJobResponse,
  CronJobsResponse,
  CronNotifyPref,
  CronNotifyPrefsResponse,
  CronOutputDetail,
  CronOutputsResponse,
  JobOutputSummaryResponse,
} from "./types";

// Light type-guards at the network boundary. We don't use zod here to avoid
// pulling a dep just for runtime checks of fields we already coerce defensively.
// If the backend ever drifts, these guards fail fast rather than silently
// surfacing undefined into the UI.

function asJob(raw: unknown): CronJob {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid cron job payload");
  }
  const j = raw as Record<string, unknown>;
  if (typeof j.id !== "string") throw new Error("Invalid cron job: missing id");
  // notifyOnComplete is the gateway augmentation; default to false if absent
  // (defensive — backend agent should always set it).
  if (typeof j.notifyOnComplete !== "boolean") {
    j.notifyOnComplete = false;
  }
  return j as unknown as CronJob;
}

export async function listJobs(): Promise<CronJobsResponse> {
  const data = await apiFetch<CronJobsResponse>("/cron/jobs");
  if (!data || !Array.isArray(data.jobs)) {
    throw new Error("Invalid /cron/jobs response shape");
  }
  return { jobs: data.jobs.map(asJob) };
}

export async function getJob(id: string): Promise<CronJobResponse> {
  const data = await apiFetch<CronJobResponse>(`/cron/jobs/${encodeURIComponent(id)}`);
  return asJob(data) as CronJobResponse;
}

export async function listOutputs(jobId: string): Promise<CronOutputsResponse> {
  const data = await apiFetch<CronOutputsResponse>(`/cron/outputs`, {
    query: { job_id: jobId },
  });
  if (!data || !Array.isArray(data.outputs)) {
    throw new Error("Invalid /cron/outputs response shape");
  }
  return data;
}

export async function getOutput(
  jobId: string,
  outputId: string,
): Promise<CronOutputDetail> {
  const data = await apiFetch<CronOutputDetail>(
    `/cron/outputs/${encodeURIComponent(outputId)}`,
    { query: { job_id: jobId } },
  );
  if (!data || typeof data.id !== "string" || typeof data.content !== "string") {
    throw new Error("Invalid /cron/outputs/:id response shape");
  }
  return data;
}

/**
 * Aggregated "one row per job that has outputs" view used by the Outputs
 * tab on the cron screen. Includes outputs whose parent job has been
 * deleted — the on-disk dir survives. Frontend joins by jobId against
 * /cron/jobs and surfaces an "archived" affordance for unmatched ids.
 */
export async function listOutputsByJob(): Promise<JobOutputSummaryResponse> {
  const data = await apiFetch<JobOutputSummaryResponse>(
    `/cron/outputs/by-job`,
  );
  if (!data || !Array.isArray(data.items)) {
    throw new Error("Invalid /cron/outputs/by-job response shape");
  }
  return data;
}

export async function setNotifyPref(
  jobId: string,
  notifyOnComplete: boolean,
): Promise<CronNotifyPref> {
  const data = await apiFetch<CronNotifyPref>(
    `/cron/jobs/${encodeURIComponent(jobId)}/notify-prefs`,
    { method: "PUT", body: { notifyOnComplete } },
  );
  if (!data || typeof data.jobId !== "string") {
    throw new Error("Invalid notify-prefs response");
  }
  return data;
}

export async function listNotifyPrefs(): Promise<CronNotifyPrefsResponse> {
  const data = await apiFetch<CronNotifyPrefsResponse>(`/cron/notify-prefs`);
  if (!data || !Array.isArray(data.prefs)) {
    throw new Error("Invalid /cron/notify-prefs response");
  }
  return data;
}

// ─── mutations (Stage 7) ────────────────────────────────────────────────
//
// Hermes accepts arbitrary additional fields on create/update; we expose only
// the ones the UI actively writes (name, prompt, schedule, deliver, model,
// enabled_toolsets, workdir). Unknown fields are dropped client-side rather
// than leaked through.

export interface CronJobInput {
  name: string;
  prompt: string;
  /** Cron expression string (e.g. "0 9 * * 1-5"). */
  schedule: string;
  /** "origin" | "local" | "telegram" | "discord" — backend validates. */
  deliver?: string | null;
  model?: string | null;
  enabled_toolsets?: string[] | null;
  workdir?: string | null;
  notifyOnComplete?: boolean;
}

export type CronJobUpdate = Partial<CronJobInput>;

export async function createJob(input: CronJobInput): Promise<CronJob> {
  const data = await apiFetch<CronJob>("/cron/jobs", {
    method: "POST",
    body: input,
  });
  return asJob(data);
}

export async function updateJob(
  id: string,
  patch: CronJobUpdate,
): Promise<CronJob> {
  const data = await apiFetch<CronJob>(`/cron/jobs/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: patch,
  });
  return asJob(data);
}

export async function pauseJob(id: string): Promise<CronJob> {
  const data = await apiFetch<CronJob>(
    `/cron/jobs/${encodeURIComponent(id)}/pause`,
    { method: "POST" },
  );
  return asJob(data);
}

export async function resumeJob(id: string): Promise<CronJob> {
  const data = await apiFetch<CronJob>(
    `/cron/jobs/${encodeURIComponent(id)}/resume`,
    { method: "POST" },
  );
  return asJob(data);
}

export async function triggerJob(id: string): Promise<CronJob> {
  const data = await apiFetch<CronJob>(
    `/cron/jobs/${encodeURIComponent(id)}/trigger`,
    { method: "POST" },
  );
  return asJob(data);
}

export async function deleteJob(id: string): Promise<void> {
  await apiFetch<void>(`/cron/jobs/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

// Centralized React Query keys — co-located with the client so callers can't
// drift from the actual endpoints.
export const cronKeys = {
  all: ["cron"] as const,
  jobs: () => ["cron", "jobs"] as const,
  job: (jobId: string) => ["cron", "job", jobId] as const,
  outputs: (jobId: string) => ["cron", "outputs", jobId] as const,
  outputsByJob: () => ["cron", "outputs", "by-job"] as const,
  output: (jobId: string, outputId: string) =>
    ["cron", "output", jobId, outputId] as const,
  prefs: () => ["cron", "prefs"] as const,
};
