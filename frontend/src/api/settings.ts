import { apiFetch } from "./client";

// ─── Vision (legacy aliases — still work post Stage-4 backend) ────
export interface VisionProvider {
  id: string;
  label: string;
  envKey?: string;
  needsBaseUrl?: boolean;
  hint?: string;
}

export interface VisionConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  timeoutS: number;
  explicitOverride: boolean;
}

export interface VisionConfigUpdate {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  timeoutS: number;
}

export async function getVisionProviders(): Promise<VisionProvider[]> {
  const data = await apiFetch<{ providers: VisionProvider[] }>("/settings/vision/providers");
  return data.providers;
}

export async function getSuggestedVisionModels(provider: string): Promise<string[]> {
  const data = await apiFetch<{ models: string[] }>(
    `/settings/vision/suggested-models?provider=${encodeURIComponent(provider)}`,
  );
  return data.models;
}

export async function getVisionConfig(): Promise<VisionConfig> {
  return apiFetch<VisionConfig>("/settings/vision");
}

export async function updateVisionConfig(update: VisionConfigUpdate): Promise<VisionConfig> {
  return apiFetch<VisionConfig>("/settings/vision", {
    method: "PUT",
    body: update,
  });
}

// ─── Aux (vision + non-vision tasks via the new generic endpoints) ────

/**
 * Identifiers for auxiliary model tasks.
 * Backend (Agent A) implements `/settings/aux/:task` with these slugs.
 */
export type AuxTask =
  | "vision"
  | "web_extract"
  | "compression"
  | "session_search"
  | "skills_hub"
  | "approval";

export interface AuxTaskMeta {
  id: AuxTask;
  label: string;
  description: string;
}

/** Same payload shape as VisionConfig — every aux task has provider/model/baseUrl/apiKey. */
export type AuxConfig = VisionConfig;
export type AuxConfigUpdate = VisionConfigUpdate;

export async function getAuxTasks(): Promise<AuxTaskMeta[]> {
  const data = await apiFetch<{ tasks: AuxTaskMeta[] }>("/settings/aux/tasks");
  return data.tasks ?? [];
}

export async function getAuxProviders(): Promise<VisionProvider[]> {
  // Backend exposes /settings/aux/providers as a generalized version of
  // /settings/vision/providers. Fall back to the vision endpoint if not yet
  // deployed (Agent A may land routes after this code).
  try {
    const data = await apiFetch<{ providers: VisionProvider[] }>("/settings/aux/providers");
    return data.providers;
  } catch {
    return getVisionProviders();
  }
}

export async function getAuxSuggestedModels(
  task: AuxTask,
  provider: string,
): Promise<string[]> {
  try {
    const data = await apiFetch<{ models: string[] }>(
      `/settings/aux/suggested-models?provider=${encodeURIComponent(provider)}&task=${encodeURIComponent(task)}`,
    );
    return data.models;
  } catch {
    if (task === "vision") return getSuggestedVisionModels(provider);
    return [];
  }
}

export async function getAuxConfig(task: AuxTask): Promise<AuxConfig> {
  if (task === "vision") {
    // Prefer the new alias; fall back to legacy.
    try {
      return await apiFetch<AuxConfig>("/settings/aux/vision");
    } catch {
      return getVisionConfig();
    }
  }
  return apiFetch<AuxConfig>(`/settings/aux/${encodeURIComponent(task)}`);
}

export async function updateAuxConfig(
  task: AuxTask,
  update: AuxConfigUpdate,
): Promise<AuxConfig> {
  if (task === "vision") {
    try {
      return await apiFetch<AuxConfig>("/settings/aux/vision", {
        method: "PUT",
        body: update,
      });
    } catch {
      return updateVisionConfig(update);
    }
  }
  return apiFetch<AuxConfig>(`/settings/aux/${encodeURIComponent(task)}`, {
    method: "PUT",
    body: update,
  });
}

// ─── Main model picker ─────────────────────────────────────────────

export interface ModelCapabilities {
  supports_vision: boolean;
  supports_tools: boolean;
  supports_reasoning: boolean;
  context_window: number | null;
  max_output_tokens: number | null;
}

export interface MainModelConfig {
  provider: string;
  model: string;
  capabilities: ModelCapabilities;
  contextWindow: number | null;
}

export interface ModelProviderMeta {
  id: string;
  label: string;
  envKey?: string;
  modelCount: number;
}

export interface ModelListEntry {
  id: string;
  label: string;
  contextWindow: number | null;
  supportsVision: boolean;
  supportsTools: boolean;
  supportsReasoning: boolean;
  /** Optional provider-id pass-through if backend groups by provider in the same response. */
  provider?: string;
}

export async function getMainModel(): Promise<MainModelConfig> {
  return apiFetch<MainModelConfig>("/settings/model");
}

export async function updateMainModel(provider: string, model: string): Promise<MainModelConfig> {
  return apiFetch<MainModelConfig>("/settings/model", {
    method: "PUT",
    body: { provider, model },
  });
}

export async function getModelProviders(): Promise<ModelProviderMeta[]> {
  const data = await apiFetch<{ providers: ModelProviderMeta[] }>("/settings/model/providers");
  return data.providers ?? [];
}

export interface ModelListQuery {
  provider?: string;
  filter?: string;
  q?: string;
}

export async function getModelList(query: ModelListQuery = {}): Promise<ModelListEntry[]> {
  const params: string[] = [];
  if (query.provider) params.push(`provider=${encodeURIComponent(query.provider)}`);
  if (query.filter) params.push(`filter=${encodeURIComponent(query.filter)}`);
  if (query.q) params.push(`q=${encodeURIComponent(query.q)}`);
  const qs = params.length ? `?${params.join("&")}` : "";
  const data = await apiFetch<{ models: ModelListEntry[] }>(`/settings/model/list${qs}`);
  return data.models ?? [];
}

// ─── About / status ────────────────────────────────────────────────

export interface ServerStatus {
  hermesVersion?: string;
  gatewayVersion?: string;
  commit?: string;
  uptime?: number;
  /** Permit unknown extras the gateway may surface. */
  [key: string]: unknown;
}

export async function getServerStatus(): Promise<ServerStatus> {
  return apiFetch<ServerStatus>("/api/status");
}

// ─── Read-only summary helpers used by the settings index ──────────
// These are best-effort aggregate queries — they fail soft so the hub
// still renders even when an upstream endpoint is missing.

export interface KeysSummary {
  set: number;
  unset: number;
}

export async function getKeysSummary(): Promise<KeysSummary> {
  try {
    const data = await apiFetch<{
      providers?: Array<{ set?: boolean }>;
      set?: number;
      unset?: number;
    }>("/settings/keys");
    if (typeof data?.set === "number" && typeof data?.unset === "number") {
      return { set: data.set, unset: data.unset };
    }
    const list = data?.providers ?? [];
    let set = 0;
    let unset = 0;
    for (const p of list) (p?.set ? set++ : unset++);
    return { set, unset };
  } catch {
    return { set: 0, unset: 0 };
  }
}

export interface StorageUsage {
  totalBytes: number;
  /** Optional breakdown — index page only needs the total. */
  breakdown?: Array<{ label: string; bytes: number }>;
}

export async function getStorageUsage(): Promise<StorageUsage> {
  try {
    const data = await apiFetch<StorageUsage>("/storage/usage");
    return {
      totalBytes: typeof data?.totalBytes === "number" ? data.totalBytes : 0,
      breakdown: Array.isArray(data?.breakdown) ? data.breakdown : undefined,
    };
  } catch {
    return { totalBytes: 0 };
  }
}
