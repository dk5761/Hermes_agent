import * as Notifications from "expo-notifications";
import type { Router } from "expo-router";
import type { QueryClient } from "@tanstack/react-query";
import { cronKeys } from "@/api/cron";
import { useNotificationsInbox } from "@/state/notifications-inbox";

// We expect this exact shape in the `data` field of cron-output pushes; the
// backend gateway is the single producer so a hand-rolled guard is sufficient.
interface CronOutputData {
  type: "cron_output";
  jobId: string;
  outputId: string;
}

function isCronOutputData(value: unknown): value is CronOutputData {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === "cron_output" &&
    typeof v.jobId === "string" &&
    typeof v.outputId === "string"
  );
}

// chat_complete push — fired by the backend when an LLM run takes >5 s.
interface ChatCompleteData {
  type: "chat_complete";
  appSessionId: string;
}

function isChatCompleteData(value: unknown): value is ChatCompleteData {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.type === "chat_complete" && typeof v.appSessionId === "string";
}

// ─── foreground suppression ──────────────────────────────────────────────────
// The chat screen calls setCurrentChatId(sessionId) on focus and
// setCurrentChatId(null) on blur so we know which chat the user is looking at.
// When the incoming push is for that exact chat we skip the banner/sound/list
// to avoid interrupting a conversation the user is already watching.

let _currentChatId: string | null = null;

export function setCurrentChatId(id: string | null): void {
  _currentChatId = id;
}

function isCurrentlyOnChat(data: unknown): boolean {
  if (!isChatCompleteData(data)) return false;
  return _currentChatId === data.appSessionId;
}

// Foreground display behavior. Without setNotificationHandler, foreground
// pushes are silently dropped on iOS. We choose to show alerts so the user
// notices fresh cron output even while the app is open.
// For chat_complete pushes: suppress when the user is already on that chat.
Notifications.setNotificationHandler({
  handleNotification: async (notif) => {
    const suppress = isCurrentlyOnChat(notif.request.content.data);
    return {
      shouldShowBanner: !suppress,
      shouldShowList: !suppress,
      shouldPlaySound: !suppress,
      shouldSetBadge: false,
    };
  },
});

interface SetupArgs {
  router: Router;
  queryClient: QueryClient;
}

export interface NotificationListenersHandle {
  remove: () => void;
}

function navigateToOutput(router: Router, jobId: string, outputId: string): void {
  // Expo Router typed routes — `as never` because the typed-route generation
  // doesn't yet know about /cron/[jobId]/output/[outputId] until tsc reads
  // the .expo/types output.
  router.push(
    `/(cron)/${encodeURIComponent(jobId)}/output/${encodeURIComponent(outputId)}` as never,
  );
}

function navigateToChat(router: Router, appSessionId: string): void {
  router.push(`/chat/${encodeURIComponent(appSessionId)}` as never);
}

function recordToInbox(
  notif:
    | Notifications.Notification
    | Notifications.NotificationResponse["notification"],
  receivedAt?: number,
): void {
  const req = notif.request;
  const content = req.content;
  const dataRaw = content.data;
  const data: Record<string, unknown> =
    dataRaw && typeof dataRaw === "object" ? (dataRaw as Record<string, unknown>) : {};
  useNotificationsInbox.getState().add({
    id: req.identifier,
    title: content.title ?? "",
    body: content.body ?? "",
    data,
    receivedAt,
  });
}

export function setupNotificationListeners(
  args: SetupArgs,
): NotificationListenersHandle {
  const { router, queryClient } = args;

  const receivedSub = Notifications.addNotificationReceivedListener((evt) => {
    // Always log to the inbox so the user has a history of every push the
    // app saw, regardless of payload type.
    recordToInbox(evt);
    const data = evt.request.content.data;
    if (!isCronOutputData(data)) return;
    // Refresh outputs list for this job so any open detail screen reflects
    // the new entry without a manual pull-to-refresh.
    void queryClient.invalidateQueries({ queryKey: cronKeys.outputs(data.jobId) });
    void queryClient.invalidateQueries({ queryKey: cronKeys.job(data.jobId) });
  });

  const responseSub = Notifications.addNotificationResponseReceivedListener((evt) => {
    // Tapping marks the notification read. add() is idempotent (deduped by
    // id) so it safely covers the case where the received listener didn't
    // fire (e.g., killed-state tap).
    recordToInbox(evt.notification);
    useNotificationsInbox.getState().markRead(evt.notification.request.identifier);
    const data = evt.notification.request.content.data;
    if (isCronOutputData(data)) {
      navigateToOutput(router, data.jobId, data.outputId);
      return;
    }
    if (isChatCompleteData(data)) {
      navigateToChat(router, data.appSessionId);
      return;
    }
  });

  // Cold-start tap: if the app was launched from a notification tap (killed
  // state), the response listener may miss it. Replay the last response on
  // next tick once router is mounted.
  void (async () => {
    const last = await Notifications.getLastNotificationResponseAsync();
    if (!last) return;
    recordToInbox(last.notification);
    useNotificationsInbox.getState().markRead(last.notification.request.identifier);
    const data = last.notification.request.content.data;
    if (isCronOutputData(data)) {
      navigateToOutput(router, data.jobId, data.outputId);
      return;
    }
    if (isChatCompleteData(data)) {
      navigateToChat(router, data.appSessionId);
      return;
    }
  })();

  return {
    remove: () => {
      receivedSub.remove();
      responseSub.remove();
    },
  };
}
