/**
 * Token registration for ActivityKit pushes. Backend keeps the most recent
 * token per activity so it can push updates while the app is suspended.
 */
import { apiFetch } from "./client";

export async function registerLiveActivityToken(input: {
  appSessionId: string;
  activityId: string;
  pushToken: string;
  kind: "chat" | "approval";
}): Promise<void> {
  await apiFetch("/live-activity/tokens", {
    method: "POST",
    body: input,
  });
}

export async function unregisterLiveActivityToken(activityId: string): Promise<void> {
  await apiFetch(`/live-activity/tokens/${encodeURIComponent(activityId)}`, {
    method: "DELETE",
  });
}
