import { apiFetch } from "./client";
import type {
  CreateSessionResponse,
  HistoryResponse,
  SessionsListResponse,
} from "./types";

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

export async function getMessages(id: string): Promise<HistoryResponse> {
  return apiFetch<HistoryResponse>(`/sessions/${id}/messages`);
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
