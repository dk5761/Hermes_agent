/**
 * Account / security API client.
 *
 * Backend contract (Stage 4 — Agent A):
 *   POST /auth/change-password { currentPassword, newPassword } -> { ok: true }
 *     errors: 401 current_password_incorrect, 400 new_password_too_weak
 *   GET  /auth/sessions  -> { sessions: AuthSession[] }
 *   POST /auth/sessions/:id/revoke -> 204
 */
import { apiFetch } from "./client";

export interface AuthSession {
  id: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  current: boolean;
}

export interface ChangePasswordResponse {
  ok: true;
}

export async function changePassword(input: {
  currentPassword: string;
  newPassword: string;
}): Promise<ChangePasswordResponse> {
  return apiFetch<ChangePasswordResponse>("/auth/change-password", {
    method: "POST",
    body: input,
  });
}

export async function listAuthSessions(): Promise<AuthSession[]> {
  const data = await apiFetch<{ sessions: AuthSession[] }>("/auth/sessions");
  return Array.isArray(data?.sessions) ? data.sessions : [];
}

export async function revokeAuthSession(id: string): Promise<void> {
  await apiFetch<void>(`/auth/sessions/${encodeURIComponent(id)}/revoke`, {
    method: "POST",
  });
}
