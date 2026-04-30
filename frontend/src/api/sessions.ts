import { apiFetch } from "./client";
import type {
  CreateSessionResponse,
  MessagesResponse,
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

export async function getMessages(id: string): Promise<MessagesResponse> {
  return apiFetch<MessagesResponse>(`/sessions/${id}/messages`);
}
