/**
 * dev-settings — toggles surfaced in Settings → Diagnostics that mock
 * runtime conditions without actually disconnecting the device. Useful
 * during local development to exercise offline / queue / banner paths
 * without losing Metro's HMR connection.
 *
 * Production builds short-circuit every consumer to the real-network
 * value because `__DEV__` is false there. Even if a flag somehow ended
 * up persisted on a release build (e.g. via TestFlight from a dev
 * device's data restore), `mockOfflineActive()` returns false off-dev
 * so it's a no-op.
 *
 * Storage key: `dev.settings.v1`
 */
import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "dev.settings.v1";

export interface DevSettingsState {
  /** When true (and __DEV__ also true), every network surface behaves as offline. */
  mockOffline: boolean;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setMockOffline: (next: boolean) => void;
}

interface PersistedShape {
  mockOffline?: boolean;
}

function parse(raw: string | null): PersistedShape {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === "object") return v as PersistedShape;
    return {};
  } catch {
    return {};
  }
}

function persist(value: PersistedShape): void {
  void AsyncStorage.setItem(KEY, JSON.stringify(value)).catch(() => undefined);
}

export const useDevSettings = create<DevSettingsState>((set, get) => ({
  mockOffline: false,
  hydrated: false,

  async hydrate() {
    if (get().hydrated) return;
    const raw = await AsyncStorage.getItem(KEY);
    const v = parse(raw);
    set({ mockOffline: !!v.mockOffline, hydrated: true });
  },

  setMockOffline(next) {
    persist({ mockOffline: next });
    set({ mockOffline: next });
  },
}));

/**
 * Synchronous read, safe to call from non-React contexts (apiFetch, WS
 * client, queue drainers). Always returns false in production so the
 * codepath is dead-stripped at minification time.
 */
export function mockOfflineActive(): boolean {
  if (!__DEV__) return false;
  return useDevSettings.getState().mockOffline;
}
