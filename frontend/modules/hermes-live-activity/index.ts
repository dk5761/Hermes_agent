/**
 * Bridge to ActivityKit. Auto no-ops on Android + on iOS < 16.2.
 *
 * Mirrors `HermesActivityAttributes.swift`. Keep the two in sync.
 */
import { NativeModulesProxy, requireNativeModule } from "expo-modules-core";

export type ActivityKind = "chat" | "approval";

export interface ActivityAttrs {
  appSessionId: string;
  sessionTitle: string;
}

export interface ActivityContentState {
  kind: ActivityKind;
  status: "thinking" | "tool" | "responding" | "awaiting";
  detail?: string | null;
  elapsedSec: number;
  modelName?: string | null;
  updatedAtEpochMs: number;
  openUrl?: string | null;
}

export interface ActiveActivity {
  id: string;
  appSessionId: string;
  sessionTitle: string;
  state: ActivityContentState;
}

interface NativeModule {
  supported: boolean;
  isSupported(): Promise<boolean>;
  areEnabled(): Promise<boolean>;
  start(
    attrs: ActivityAttrs,
    state: ActivityContentState,
  ): Promise<string | null>;
  update(activityId: string, state: ActivityContentState): Promise<boolean>;
  end(
    activityId: string,
    finalState?: ActivityContentState | null,
    dismiss?: "default" | "immediate",
  ): Promise<boolean>;
  getPushToken(activityId: string): Promise<string | null>;
  listActive(): Promise<ActiveActivity[]>;
  endAll(): Promise<void>;
}

const STUB: NativeModule = {
  supported: false,
  async isSupported() {
    return false;
  },
  async areEnabled() {
    return false;
  },
  async start() {
    return null;
  },
  async update() {
    return false;
  },
  async end() {
    return false;
  },
  async getPushToken() {
    return null;
  },
  async listActive() {
    return [];
  },
  async endAll() {
    return;
  },
};

function loadNative(): NativeModule {
  // Touch the modules proxy so the call gets the up-to-date module
  // registry; harmless on platforms where ExpoModulesCore isn't loaded.
  void NativeModulesProxy;
  try {
    return requireNativeModule<NativeModule>("HermesLiveActivity");
  } catch {
    // Module not linked (Expo Go, Android, dev client without rebuild) →
    // return a stub so callers don't have to null-check on every site.
    return STUB;
  }
}

const native: NativeModule = loadNative();

export default native;
