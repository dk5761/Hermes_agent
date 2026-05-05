/**
 * quick-switcher store — ephemeral visibility flag for the QuickSwitcher
 * search modal (Phase 4 of the Hermes search feature).
 *
 * No persistence: the modal is a transient UI surface, never expected to
 * survive a relaunch. The recent-queries MRU is persisted separately by
 * `useRecentSearches` (Phase 3); this store only owns the open/closed bit.
 *
 * `toggle()` is provided ahead of Phase 5's keyboard-shortcut work
 * (Cmd+K on iPad), where a single dispatch toggles regardless of the
 * current state.
 */
import { create } from "zustand";

export interface QuickSwitcherState {
  visible: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
}

export const useQuickSwitcher = create<QuickSwitcherState>((set, get) => ({
  visible: false,
  open: () => set({ visible: true }),
  close: () => set({ visible: false }),
  toggle: () => set({ visible: !get().visible }),
}));
