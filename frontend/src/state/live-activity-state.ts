/**
 * In-memory map: app session id → currently-running ActivityKit activity id.
 * Backed by ActivityKit on iOS 16.2+; on every other platform / version the
 * native module is a stub so all of this becomes inert.
 *
 * Lifecycle (driven by `useChatStream` envelopes — see ws-bridge.ts):
 *   message.start         → start activity {kind: chat, status: thinking}
 *   tool.start            → update {status: tool, detail: name}
 *   tool.complete         → update {status: thinking, detail: null}
 *   message.delta         → update {status: responding}
 *   message.complete      → end (immediate)
 *   error                 → end (immediate)
 *   approval.request      → start {kind: approval, status: awaiting, detail: cmd}
 *                           (or transition the existing chat activity in place)
 *   approval.respond      → end (immediate)
 *
 * We also keep the latest *push token* per activity so the gateway can
 * deliver updates while the app is suspended (Stage 4).
 */
import { create } from "zustand";

export interface ActivityRecord {
  activityId: string;
  appSessionId: string;
  startedAt: number;
  pushToken: string | null;
  // Last "kind" so we can decide whether to in-place transition (chat→
  // approval) or end+start a fresh activity.
  kind: "chat" | "approval";
}

interface LiveActivityState {
  bySession: Record<string, ActivityRecord>;
  setActivity: (sessionId: string, rec: ActivityRecord | null) => void;
  setPushToken: (sessionId: string, token: string) => void;
  getActivity: (sessionId: string) => ActivityRecord | null;
  clear: () => void;
}

export const useLiveActivityState = create<LiveActivityState>((set, get) => ({
  bySession: {},

  setActivity(sessionId, rec) {
    set((s) => {
      const next = { ...s.bySession };
      if (rec) next[sessionId] = rec;
      else delete next[sessionId];
      return { bySession: next };
    });
  },

  setPushToken(sessionId, token) {
    set((s) => {
      const cur = s.bySession[sessionId];
      if (!cur || cur.pushToken === token) return s;
      return {
        bySession: { ...s.bySession, [sessionId]: { ...cur, pushToken: token } },
      };
    });
  },

  getActivity(sessionId) {
    return get().bySession[sessionId] ?? null;
  },

  clear() {
    set({ bySession: {} });
  },
}));
