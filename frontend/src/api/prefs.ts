import { apiFetch } from "./client";
import { ApiError } from "./types";

// User-level preferences stored on the gateway (not device-local).
// Currently a single field; extend this interface as the backend grows.

export interface UserPrefs {
  notifyChatComplete: boolean;
}

// Default prefs used when the server returns 404 (user has never written a
// pref record) or when the network is unavailable. Default = enabled so
// new users get notifications without any explicit opt-in step.
const DEFAULT_PREFS: UserPrefs = {
  notifyChatComplete: true,
};

function asUserPrefs(raw: unknown): UserPrefs {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid /users/me/prefs response shape");
  }
  const r = raw as Record<string, unknown>;
  // notifyChatComplete defaults true if absent (defensive — backend should
  // always set it once a record exists).
  const notifyChatComplete =
    typeof r.notifyChatComplete === "boolean" ? r.notifyChatComplete : true;
  return { notifyChatComplete };
}

export async function getUserPrefs(): Promise<UserPrefs> {
  try {
    const data = await apiFetch<UserPrefs>("/users/me/prefs", { method: "GET" });
    return asUserPrefs(data);
  } catch (err) {
    // 404 = the user has never saved a pref; surface the defaults so the
    // toggle renders in a sane initial state rather than an error.
    if (err instanceof ApiError && err.status === 404) {
      return { ...DEFAULT_PREFS };
    }
    throw err;
  }
}

export async function updateUserPrefs(p: Partial<UserPrefs>): Promise<UserPrefs> {
  const data = await apiFetch<UserPrefs>("/users/me/prefs", {
    method: "PUT",
    body: p,
  });
  return asUserPrefs(data);
}
