/**
 * Bridge between the chat stream and ActivityKit.
 *
 * Public API:
 *   - `chatRunStarted(sessionId, sessionTitle, modelName?)`  on message.start
 *   - `chatRunUpdated(sessionId, patch)`                     on tool.* / delta
 *   - `chatRunEnded(sessionId)`                              on message.complete / error
 *   - `approvalPending(sessionId, command)`                  on approval.request
 *   - `approvalResolved(sessionId)`                          on approval.respond
 *   - `endAll()`                                             on logout
 *
 * Each function is a no-op when ActivityKit isn't supported.
 */
import LiveActivity, {
  type ActivityContentState,
} from "hermes-live-activity";

import {
  registerLiveActivityToken,
  unregisterLiveActivityToken,
} from "../api/live-activity";
import { useLiveActivityState } from "../state/live-activity-state";

function nowMs(): number {
  return Date.now();
}

function elapsedFromStart(startedAt: number): number {
  return Math.max(0, Math.floor((nowMs() - startedAt) / 1000));
}

function deepLink(sessionId: string, kind: "chat" | "approval"): string {
  return kind === "approval"
    ? `hermes://chat/${sessionId}/approvals`
    : `hermes://chat/${sessionId}`;
}

// Throttle local updates to 200ms per activity so a tool burst doesn't
// hammer ActivityKit (which silently rate-limits anyway).
const lastUpdate = new Map<string, number>();
function shouldUpdate(activityId: string, minIntervalMs = 200): boolean {
  const t = lastUpdate.get(activityId) ?? 0;
  const now = nowMs();
  if (now - t < minIntervalMs) return false;
  lastUpdate.set(activityId, now);
  return true;
}

async function captureAndRegisterToken(
  sessionId: string,
  activityId: string,
  kind: "chat" | "approval",
): Promise<void> {
  // Token may take a moment to materialize. The native side waits up to
  // 1.5s so we don't tie up the JS thread polling.
  const token = await LiveActivity.getPushToken(activityId);
  if (!token) return;
  useLiveActivityState.getState().setPushToken(sessionId, token);
  try {
    await registerLiveActivityToken({
      appSessionId: sessionId,
      activityId,
      pushToken: token,
      kind,
    });
  } catch {
    // Token registration is best-effort — if the gateway is offline we
    // still get foreground updates via direct JS calls.
  }
}

export async function chatRunStarted(
  sessionId: string,
  sessionTitle: string,
  modelName?: string | null,
): Promise<void> {
  const existing = useLiveActivityState.getState().getActivity(sessionId);
  if (existing && existing.kind === "chat") return; // already running
  if (existing) {
    // Existing was an approval activity for the same session — end it
    // before opening the chat one. Cleaner than transitioning kinds.
    await LiveActivity.end(existing.activityId, null, "immediate");
    useLiveActivityState.getState().setActivity(sessionId, null);
  }

  const startedAt = nowMs();
  const initialState: ActivityContentState = {
    kind: "chat",
    status: "thinking",
    detail: null,
    elapsedSec: 0,
    modelName: modelName ?? null,
    updatedAtEpochMs: startedAt,
    openUrl: deepLink(sessionId, "chat"),
  };
  const activityId = await LiveActivity.start(
    { appSessionId: sessionId, sessionTitle },
    initialState,
  );
  if (!activityId) return;

  useLiveActivityState.getState().setActivity(sessionId, {
    activityId,
    appSessionId: sessionId,
    startedAt,
    pushToken: null,
    kind: "chat",
  });
  void captureAndRegisterToken(sessionId, activityId, "chat");
}

export async function chatRunUpdated(
  sessionId: string,
  patch: {
    status?: ActivityContentState["status"];
    detail?: string | null;
    modelName?: string | null;
  },
): Promise<void> {
  const rec = useLiveActivityState.getState().getActivity(sessionId);
  if (!rec) return;
  if (!shouldUpdate(rec.activityId)) return;
  const elapsedSec = elapsedFromStart(rec.startedAt);
  const next: ActivityContentState = {
    kind: rec.kind,
    status: patch.status ?? "thinking",
    detail: patch.detail ?? null,
    elapsedSec,
    modelName: patch.modelName ?? null,
    updatedAtEpochMs: nowMs(),
    openUrl: deepLink(sessionId, rec.kind),
  };
  await LiveActivity.update(rec.activityId, next);
}

export async function chatRunEnded(sessionId: string): Promise<void> {
  const rec = useLiveActivityState.getState().getActivity(sessionId);
  if (!rec) return;
  await LiveActivity.end(rec.activityId, null, "immediate");
  useLiveActivityState.getState().setActivity(sessionId, null);
  try {
    await unregisterLiveActivityToken(rec.activityId);
  } catch {
    /* ignore */
  }
}

export async function approvalPending(
  sessionId: string,
  sessionTitle: string,
  command: string,
): Promise<void> {
  // If an existing chat activity is running for this session we end it
  // first so the approval one is unambiguous on the lock screen.
  const existing = useLiveActivityState.getState().getActivity(sessionId);
  if (existing && existing.kind === "approval") {
    // Update detail in place — multiple sequential approvals reuse one
    // activity rather than flickering the lock screen.
    await LiveActivity.update(existing.activityId, {
      kind: "approval",
      status: "awaiting",
      detail: command,
      elapsedSec: elapsedFromStart(existing.startedAt),
      modelName: null,
      updatedAtEpochMs: nowMs(),
      openUrl: deepLink(sessionId, "approval"),
    });
    return;
  }
  if (existing) {
    await LiveActivity.end(existing.activityId, null, "immediate");
    useLiveActivityState.getState().setActivity(sessionId, null);
  }
  const startedAt = nowMs();
  const initialState: ActivityContentState = {
    kind: "approval",
    status: "awaiting",
    detail: command,
    elapsedSec: 0,
    modelName: null,
    updatedAtEpochMs: startedAt,
    openUrl: deepLink(sessionId, "approval"),
  };
  const activityId = await LiveActivity.start(
    { appSessionId: sessionId, sessionTitle },
    initialState,
  );
  if (!activityId) return;
  useLiveActivityState.getState().setActivity(sessionId, {
    activityId,
    appSessionId: sessionId,
    startedAt,
    pushToken: null,
    kind: "approval",
  });
  void captureAndRegisterToken(sessionId, activityId, "approval");
}

export async function approvalResolved(sessionId: string): Promise<void> {
  const rec = useLiveActivityState.getState().getActivity(sessionId);
  if (!rec || rec.kind !== "approval") return;
  await LiveActivity.end(rec.activityId, null, "immediate");
  useLiveActivityState.getState().setActivity(sessionId, null);
  try {
    await unregisterLiveActivityToken(rec.activityId);
  } catch {
    /* ignore */
  }
}

export async function endAll(): Promise<void> {
  const all = Object.values(useLiveActivityState.getState().bySession);
  await LiveActivity.endAll();
  useLiveActivityState.getState().clear();
  for (const rec of all) {
    try {
      await unregisterLiveActivityToken(rec.activityId);
    } catch {
      /* ignore */
    }
  }
}

// Sync our in-memory map with whatever ActivityKit thinks is alive (called
// on app cold start). End any orphans we don't recognize.
export async function reconcileOnLaunch(): Promise<void> {
  const live = await LiveActivity.listActive();
  if (live.length === 0) return;
  for (const a of live) {
    // We don't have a started-at; close the orphan immediately rather than
    // leave a stale "running" pill in the user's island.
    await LiveActivity.end(a.id, null, "immediate");
    try {
      await unregisterLiveActivityToken(a.id);
    } catch {
      /* ignore */
    }
  }
}
