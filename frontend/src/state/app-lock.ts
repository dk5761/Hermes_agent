/**
 * app-lock store — biometric gate for the whole app.
 *
 * Three concerns:
 *   1. **Preference** — `enabled` (bool) lives in SecureStore so a stolen
 *      device backup can't read it as plain text. Hydrate on app boot.
 *   2. **Capability** — `available` (bool) reflects whether the device has
 *      enrolled biometrics. Simulators / emulators usually don't, so we
 *      auto-treat the lock as off there.
 *   3. **Runtime state** — `locked` flips true on app launch (when
 *      enabled+available) and on every transition to background. The
 *      overlay component watches `locked` and prompts for FaceID/TouchID.
 */
import { Platform } from "react-native";
import { create } from "zustand";
import * as SecureStore from "expo-secure-store";
import * as LocalAuthentication from "expo-local-authentication";

const KEY = "app_lock_enabled_v1";

export interface AppLockState {
  // User preference. Persisted.
  enabled: boolean;
  // Device has enrolled biometrics? On emulator/web typically false.
  available: boolean;
  // Hydrated `enabled` from SecureStore yet?
  hydrated: boolean;
  // Currently waiting for biometric unlock?
  locked: boolean;
  hydrate: () => Promise<void>;
  setEnabled: (next: boolean) => Promise<void>;
  // Called by the AppState listener when the app goes background → next
  // foreground should re-prompt.
  rearm: () => void;
  unlock: () => void;
}

async function probeAvailable(): Promise<boolean> {
  if (Platform.OS === "web") return false;
  try {
    const hw = await LocalAuthentication.hasHardwareAsync();
    if (!hw) return false;
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    return enrolled;
  } catch {
    return false;
  }
}

export const useAppLock = create<AppLockState>((set, get) => ({
  enabled: false,
  available: false,
  hydrated: false,
  locked: false,

  async hydrate() {
    if (get().hydrated) return;
    let enabled = false;
    try {
      const raw = await SecureStore.getItemAsync(KEY);
      enabled = raw === "1";
    } catch {
      // SecureStore failure → treat as disabled. We never block the app on
      // hydration errors.
    }
    const available = await probeAvailable();
    // If user enabled the lock previously but biometrics aren't enrolled
    // anymore (passcode removed, simulator), don't lock — they'd be
    // permanently locked out otherwise.
    const effectiveEnabled = enabled && available;
    set({
      enabled,
      available,
      hydrated: true,
      locked: effectiveEnabled,
    });
  },

  async setEnabled(next) {
    try {
      await SecureStore.setItemAsync(KEY, next ? "1" : "0");
    } catch {
      // ignore — best effort. The in-memory toggle still updates.
    }
    set({ enabled: next });
  },

  rearm() {
    const { enabled, available } = get();
    if (enabled && available) set({ locked: true });
  },

  unlock() {
    set({ locked: false });
  },
}));

export async function authenticateBiometric(): Promise<boolean> {
  try {
    const res = await LocalAuthentication.authenticateAsync({
      promptMessage: "Unlock Hermes",
      cancelLabel: "Cancel",
      // Allow device passcode as a fallback so a missing finger / face
      // doesn't lock the user out.
      disableDeviceFallback: false,
    });
    return res.success;
  } catch {
    return false;
  }
}
