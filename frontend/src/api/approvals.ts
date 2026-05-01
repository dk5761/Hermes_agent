/**
 * Approval policy API — Hermes' permanent allowlist (config.command_allowlist).
 * Each pattern is a CLI-style command-pattern key (e.g. "rm", "git push").
 *
 * Session-scoped approvals are managed via the inline ApprovalCard (the
 * "Allow always" button sends choice="session") and are not exposed here.
 */
import { apiFetch } from "./client";

export interface ApprovalsResponse {
  patterns: string[];
}

export async function listApprovals(): Promise<string[]> {
  const data = await apiFetch<ApprovalsResponse>("/settings/approvals");
  return data.patterns ?? [];
}

export async function addApproval(pattern: string): Promise<string[]> {
  const data = await apiFetch<ApprovalsResponse>("/settings/approvals", {
    method: "POST",
    body: { pattern },
  });
  return data.patterns ?? [];
}

export async function removeApproval(pattern: string): Promise<string[]> {
  const data = await apiFetch<ApprovalsResponse>(
    `/settings/approvals/${encodeURIComponent(pattern)}`,
    { method: "DELETE" },
  );
  return data.patterns ?? [];
}
