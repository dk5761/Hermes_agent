import { apiFetch } from "./client";
import type {
  CronJob,
  CronJobResponse,
  CronJobsResponse,
  CronNotifyPref,
  CronNotifyPrefsResponse,
  CronOutputDetail,
  CronOutputsResponse,
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

// Centralized React Query keys — co-located with the client so callers can't
// drift from the actual endpoints.
export const cronKeys = {
  all: ["cron"] as const,
  jobs: () => ["cron", "jobs"] as const,
  job: (jobId: string) => ["cron", "job", jobId] as const,
  outputs: (jobId: string) => ["cron", "outputs", jobId] as const,
  output: (jobId: string, outputId: string) =>
    ["cron", "output", jobId, outputId] as const,
  prefs: () => ["cron", "prefs"] as const,
};
