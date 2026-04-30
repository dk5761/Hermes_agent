import { apiFetch } from "./client";

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
