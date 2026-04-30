import { apiFetch } from "./client";
import type { LoginResponse, RefreshResponse } from "./types";

export async function login(username: string, password: string): Promise<LoginResponse> {
  return apiFetch<LoginResponse>("/auth/login", {
    method: "POST",
    body: { username, password },
    skipAuth: true,
  });
}

export async function refresh(refreshToken: string): Promise<RefreshResponse> {
  return apiFetch<RefreshResponse>("/auth/refresh", {
    method: "POST",
    body: { refreshToken },
    skipAuth: true,
  });
}

// Best-effort: server may 400 if token already gone; we ignore and clear local state regardless.
export async function logout(refreshToken: string): Promise<void> {
  try {
    await apiFetch("/auth/logout", {
      method: "POST",
      body: { refreshToken },
      skipAuth: true,
    });
  } catch {
    // intentional: logout always succeeds client-side.
  }
}
