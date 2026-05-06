import { apiFetch } from "./client";
import type {
  BranchSessionResponse,
  CreateSessionResponse,
  MessagesPage,
  SessionsListResponse,
} from "./types";

/** Pagination opts for {@link getMessages}. */
export interface GetMessagesOpts {
  /** Page size. Server caps at 100, defaults to 50. */
  limit?: number;
  /** Returns rows where chat_history.id < before. Mutually exclusive with `around`. */
  before?: number;
  /** Centered window: ~limit/2 before + ~limit/2 after the target id. */
  around?: number;
}

export async function listSessions(): Promise<SessionsListResponse> {
  return apiFetch<SessionsListResponse>("/sessions");
}

export async function createSession(title?: string): Promise<CreateSessionResponse> {
  return apiFetch<CreateSessionResponse>("/sessions", {
    method: "POST",
    body: title ? { title } : {},
  });
}

export async function renameSession(id: string, title: string): Promise<void> {
  await apiFetch(`/sessions/${id}`, {
    method: "PATCH",
    body: { title },
  });
}

export async function archiveSession(id: string, archived: boolean): Promise<void> {
  await apiFetch(`/sessions/${id}`, {
    method: "PATCH",
    body: { archived },
  });
}

export async function deleteSession(id: string): Promise<void> {
  await apiFetch(`/sessions/${id}`, { method: "DELETE" });
}

export interface SessionModelOverrideResponse {
  id: string;
  modelOverride: string | null;
  providerOverride: string | null;
}

export async function setSessionModel(
  id: string,
  body: { provider: string; model: string } | { clear: true },
): Promise<SessionModelOverrideResponse> {
  return apiFetch<SessionModelOverrideResponse>(`/sessions/${id}/model`, {
    method: "PUT",
    body,
  });
}

export async function getMessages(
  id: string,
  opts: GetMessagesOpts = {},
): Promise<MessagesPage> {
  const query: Record<string, number | undefined> = {};
  if (opts.limit !== undefined) query.limit = opts.limit;
  if (opts.before !== undefined) query.before = opts.before;
  if (opts.around !== undefined) query.around = opts.around;
  return apiFetch<MessagesPage>(`/sessions/${id}/messages`, { query });
}

/** Per-model row in {@link SessionUsage.byModel}. Mirrors the backend type. */
export interface SessionUsageByModel {
  model: string;
  provider: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  costUsd: number;
}

/** Aggregated usage + computed cost for a single session. */
export interface SessionUsage {
  totals: {
    tokensIn: number;
    tokensOut: number;
    tokensCached: number;
    costUsd: number;
    turns: number;
  };
  byModel: SessionUsageByModel[];
}

export async function getSessionUsage(id: string): Promise<SessionUsage> {
  return apiFetch<SessionUsage>(`/sessions/${id}/usage`);
}

export interface ReloadMcpResponse {
  output: string;
  warning: string | null;
}

export async function reloadSessionMcp(id: string): Promise<ReloadMcpResponse> {
  return apiFetch<ReloadMcpResponse>(`/sessions/${id}/reload-mcp`, {
    method: "POST",
  });
}

/**
 * Fork a session — creates a new app-session whose Hermes-side history is a
 * copy of the parent's at branch time. Body is optional; an empty title lets
 * the backend auto-suffix `<parent> (branch)`. Errors:
 *   409 no_hermes_session   — parent has zero turns yet, nothing to copy.
 *   502 branch_parse_failed — Hermes returned output we couldn't parse.
 *   503 slash_failed        — Hermes /branch slash failed or DB write failed.
 */
export async function branchSession(
  id: string,
  opts?: { title?: string },
): Promise<BranchSessionResponse> {
  return apiFetch<BranchSessionResponse>(`/sessions/${id}/branch`, {
    method: "POST",
    body: opts?.title ? { title: opts.title } : {},
  });
}

// Loosely-typed search response — the upstream Hermes payload shape is not
// strictly defined (HERMES_CONTRACT.md flags it explicitly). We model the
// most common variants and let the renderer normalize defensively.
export interface SearchHit {
  // Both shapes appear depending on whether the match is a session title or
  // a message body. The screen normalizes by checking which fields exist.
  sessionId?: string;
  appSessionId?: string;
  hermesSessionId?: string;
  title?: string;
  preview?: string;
  text?: string;
  snippet?: string;
  match?: [number, number] | null;
  line?: number;
  createdAt?: number | string;
  updatedAt?: number | string;
  [key: string]: unknown;
}

export interface SearchResponse {
  results?: SearchHit[];
  sessions?: SearchHit[];
  matches?: SearchHit[];
  [key: string]: unknown;
}

export async function searchSessions(q: string): Promise<SearchResponse> {
  return apiFetch<SearchResponse>("/sessions/search", { query: { q } });
}
