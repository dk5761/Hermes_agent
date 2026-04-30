import * as Notifications from "expo-notifications";
import type { Router } from "expo-router";
import type { QueryClient } from "@tanstack/react-query";
import { cronKeys } from "@/api/cron";

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

// Foreground display behavior. Without setNotificationHandler, foreground
// pushes are silently dropped on iOS. We choose to show alerts so the user
// notices fresh cron output even while the app is open.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
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

export function setupNotificationListeners(
  args: SetupArgs,
): NotificationListenersHandle {
  const { router, queryClient } = args;

  const receivedSub = Notifications.addNotificationReceivedListener((evt) => {
    const data = evt.request.content.data;
    if (!isCronOutputData(data)) return;
    // Refresh outputs list for this job so any open detail screen reflects
    // the new entry without a manual pull-to-refresh.
    void queryClient.invalidateQueries({ queryKey: cronKeys.outputs(data.jobId) });
    void queryClient.invalidateQueries({ queryKey: cronKeys.job(data.jobId) });
  });

  const responseSub = Notifications.addNotificationResponseReceivedListener((evt) => {
    const data = evt.notification.request.content.data;
    if (!isCronOutputData(data)) return;
    navigateToOutput(router, data.jobId, data.outputId);
  });

  // Cold-start tap: if the app was launched from a notification tap (killed
  // state), the response listener may miss it. Replay the last response on
  // next tick once router is mounted.
  void (async () => {
    const last = await Notifications.getLastNotificationResponseAsync();
    if (!last) return;
    const data = last.notification.request.content.data;
    if (!isCronOutputData(data)) return;
    navigateToOutput(router, data.jobId, data.outputId);
  })();

  return {
    remove: () => {
      receivedSub.remove();
      responseSub.remove();
    },
  };
}
