import { create } from "zustand";
import { secureStorage } from "./secure-storage";
import type { AuthUser } from "../api/types";

// Single-tenant app: one auth state instance, hydrated from SecureStore at
// boot. The `hydrated` flag gates UI redirects until persisted state is known.

interface AuthState {
  hydrated: boolean;
  accessToken: string | null;
  refreshToken: string | null;
  user: AuthUser | null;
  hydrate: () => Promise<void>;
  setSession: (s: { accessToken: string; refreshToken: string; user: AuthUser }) => Promise<void>;
  setAccessToken: (token: string) => Promise<void>;
  /**
   * Persist a rotated token pair from /auth/refresh. The gateway revokes the
   * old refresh token server-side and issues a new one — clients must adopt
   * both atomically so a subsequent refresh uses the now-valid token.
   */
  setTokens: (tokens: { accessToken: string; refreshToken: string }) => Promise<void>;
  clear: () => Promise<void>;
}

const KEY_ACCESS = "accessToken";
const KEY_REFRESH = "refreshToken";
const KEY_USER = "user";

export const useAuthStore = create<AuthState>((set, get) => ({
  hydrated: false,
  accessToken: null,
  refreshToken: null,
  user: null,

  async hydrate() {
    if (get().hydrated) return;
    const [access, refresh, userJson] = await Promise.all([
      secureStorage.get(KEY_ACCESS),
      secureStorage.get(KEY_REFRESH),
      secureStorage.get(KEY_USER),
    ]);
    let user: AuthUser | null = null;
    if (userJson) {
      try {
        user = JSON.parse(userJson) as AuthUser;
      } catch {
        user = null;
      }
    }
    set({
      hydrated: true,
      accessToken: access,
      refreshToken: refresh,
      user,
    });
  },

  async setSession({ accessToken, refreshToken, user }) {
    await Promise.all([
      secureStorage.set(KEY_ACCESS, accessToken),
      secureStorage.set(KEY_REFRESH, refreshToken),
      secureStorage.set(KEY_USER, JSON.stringify(user)),
    ]);
    set({ accessToken, refreshToken, user });
  },

  async setAccessToken(token) {
    await secureStorage.set(KEY_ACCESS, token);
    set({ accessToken: token });
  },

  async setTokens({ accessToken, refreshToken }) {
    await Promise.all([
      secureStorage.set(KEY_ACCESS, accessToken),
      secureStorage.set(KEY_REFRESH, refreshToken),
    ]);
    set({ accessToken, refreshToken });
  },

  async clear() {
    await Promise.all([
      secureStorage.del(KEY_ACCESS),
      secureStorage.del(KEY_REFRESH),
      secureStorage.del(KEY_USER),
    ]);
    set({ accessToken: null, refreshToken: null, user: null });
  },
}));

// Snapshot accessor for non-React contexts (api client, ws client).
export function getAuthSnapshot(): {
  accessToken: string | null;
  refreshToken: string | null;
} {
  const s = useAuthStore.getState();
  return { accessToken: s.accessToken, refreshToken: s.refreshToken };
}
