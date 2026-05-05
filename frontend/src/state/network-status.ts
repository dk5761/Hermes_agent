import NetInfo, { type NetInfoState } from "@react-native-community/netinfo";
import { create } from "zustand";

import { useDevSettings } from "./dev-settings";

/**
 * network-status — single source of truth for "are we online".
 *
 * Multiple consumers want this signal: the queue drainers (Phase 4),
 * the offline banner (Phase 6), retry buttons throughout the app.
 * NetInfo's `useNetInfo` works but every call creates its own native
 * subscription — this store consolidates them into one.
 *
 * Captive portals report `isConnected: true` but
 * `isInternetReachable: false`. We treat that as offline so we don't
 * fire failing requests against an in-the-clear-but-no-internet
 * connection.
 *
 * iOS sometimes returns null for `isInternetReachable` briefly during
 * transitions. Innocent until proven offline: null → online.
 */
export interface NetworkState {
  online: boolean;
  type: string | null;
  /** Last transition timestamp; useful for debouncing UI changes. */
  changedAt: number;
  /** Initialise NetInfo subscription. Returns unsubscribe. Idempotent. */
  init: () => () => void;
}

export const useNetworkStatus = create<NetworkState>((set, get) => ({
  online: true,
  type: null,
  changedAt: Date.now(),
  init: () => {
    let lastNetInfo: NetInfoState | null = null;
    const compute = () => {
      const s = lastNetInfo;
      const realOnline = s
        ? !!s.isConnected && s.isInternetReachable !== false
        : true;
      // Dev-only mock-offline override (gated by __DEV__ inside the helper).
      // When toggled the store reports offline regardless of the real link.
      const next =
        __DEV__ && useDevSettings.getState().mockOffline ? false : realOnline;
      const now = Date.now();
      const prev = get();
      if (next === prev.online && (prev.type ?? null) === (s?.type ?? null)) {
        return;
      }
      set({
        online: next,
        type: s?.type ?? null,
        changedAt: now,
      });
    };
    const apply = (s: NetInfoState) => {
      lastNetInfo = s;
      compute();
    };
    void NetInfo.fetch().then(apply);
    const unsubNet = NetInfo.addEventListener(apply);
    // Re-derive `online` whenever the dev toggle flips.
    const unsubDev = __DEV__
      ? useDevSettings.subscribe(() => compute())
      : () => undefined;
    return () => {
      unsubNet();
      unsubDev();
    };
  },
}));
