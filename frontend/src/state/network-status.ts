import NetInfo, { type NetInfoState } from "@react-native-community/netinfo";
import { create } from "zustand";

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
    const apply = (s: NetInfoState) => {
      const next = !!s.isConnected && s.isInternetReachable !== false;
      const now = Date.now();
      const prev = get();
      if (next === prev.online && (prev.type ?? null) === (s.type ?? null)) {
        return;
      }
      set({
        online: next,
        type: s.type ?? null,
        changedAt: now,
      });
    };
    void NetInfo.fetch().then(apply);
    return NetInfo.addEventListener(apply);
  },
}));
