/**
 * Provider keys API client.
 *
 * Backend contract (Stage 4 — Agent A):
 *   GET    /settings/keys          -> { keys: ProviderKey[] }
 *   GET    /settings/keys/:envKey  -> ProviderKeyDetail
 *   PUT    /settings/keys/:envKey  -> ProviderKeyDetail   (body { value })
 *   DELETE /settings/keys/:envKey  -> 204
 */
import { apiFetch } from "./client";

export type ProviderKeyStatus = "set" | "unset";

export interface ProviderKey {
  providerId: string;
  label: string;
  envKey: string;
  status: ProviderKeyStatus;
}

export interface ProviderKeyDetail extends ProviderKey {
  lastSetAt: number | null;
}

export async function listProviderKeys(): Promise<ProviderKey[]> {
  const data = await apiFetch<{ keys: ProviderKey[] }>("/settings/keys");
  return Array.isArray(data?.keys) ? data.keys : [];
}

export async function getProviderKey(envKey: string): Promise<ProviderKeyDetail> {
  return apiFetch<ProviderKeyDetail>(`/settings/keys/${encodeURIComponent(envKey)}`);
}

export async function setProviderKey(
  envKey: string,
  value: string,
): Promise<ProviderKeyDetail> {
  return apiFetch<ProviderKeyDetail>(`/settings/keys/${encodeURIComponent(envKey)}`, {
    method: "PUT",
    body: { value },
  });
}

export async function deleteProviderKey(envKey: string): Promise<void> {
  await apiFetch<void>(`/settings/keys/${encodeURIComponent(envKey)}`, {
    method: "DELETE",
  });
}
