import { API_URL } from "../config";
import { getAuthSnapshot, useAuthStore } from "../auth/store";
import { ApiError, type ApiErrorBody } from "./types";
import { mockOfflineActive } from "../state/dev-settings";

// Shared fetch wrapper:
// - injects Authorization automatically when an access token is present.
// - on a 401, attempts a single refresh-then-retry, then clears auth on failure.
// - JSON-encodes bodies; throws ApiError on non-2xx so React Query treats it as error.

interface RequestInit_ {
  method?: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  // Set true for the refresh call itself to avoid recursion.
  skipAuth?: boolean;
}

let inflightRefresh: Promise<string | null> | null = null;

// Exported for non-HTTP paths that also need refresh (notably the WS client
// on a 4401 close). Coalesces concurrent callers via inflightRefresh so a
// burst of failing requests + a 4401 socket close share a single network call.
export async function attemptRefresh(): Promise<string | null> {
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = (async () => {
    const { refreshToken } = getAuthSnapshot();
    if (!refreshToken) return null;
    try {
      const res = await fetch(`${API_URL}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        accessToken?: string;
        refreshToken?: string;
      };
      if (!data.accessToken) return null;
      // Rotation: gateway returns a fresh refresh token alongside the access
      // token. Persist both atomically so the next refresh uses the new one
      // (the old one is revoked server-side). Older gateway versions that
      // don't rotate just return accessToken — fall back to setAccessToken
      // so we don't blow away a still-valid refresh token.
      if (data.refreshToken) {
        await useAuthStore.getState().setTokens({
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
        });
      } else {
        await useAuthStore.getState().setAccessToken(data.accessToken);
      }
      return data.accessToken;
    } catch {
      return null;
    } finally {
      inflightRefresh = null;
    }
  })();
  return inflightRefresh;
}

function buildUrl(path: string, query?: RequestInit_["query"]): string {
  const base = path.startsWith("http") ? path : `${API_URL}${path}`;
  if (!query) return base;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? `${base}?${s}` : base;
}

async function parseErrorBody(res: Response): Promise<ApiErrorBody | string> {
  try {
    return (await res.json()) as ApiErrorBody;
  } catch {
    try {
      return await res.text();
    } catch {
      return res.statusText;
    }
  }
}

export async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit_ = {},
): Promise<T> {
  const { method = "GET", body, query, signal, skipAuth = false } = init;
  // Dev-only mock-offline trap. Throw before touching fetch so the device
  // appears completely disconnected (no Metro disruption — Metro uses its
  // own debugger socket, not our app fetch).
  if (mockOfflineActive()) {
    throw new TypeError("Network request failed (mock offline)");
  }
  const url = buildUrl(path, query);

  const send = async (token: string | null): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token && !skipAuth) headers["Authorization"] = `Bearer ${token}`;
    return fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  };

  let token = getAuthSnapshot().accessToken;
  let res = await send(token);

  if (res.status === 401 && !skipAuth) {
    const refreshed = await attemptRefresh();
    if (!refreshed) {
      await useAuthStore.getState().clear();
      throw new ApiError(401, await parseErrorBody(res));
    }
    res = await send(refreshed);
  }

  if (!res.ok) {
    throw new ApiError(res.status, await parseErrorBody(res));
  }

  // Endpoints may return empty bodies (e.g., DELETE) — guard json().
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}
