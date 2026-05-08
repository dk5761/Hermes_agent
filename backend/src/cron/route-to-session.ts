/**
 * route-to-session — gateway-side cron output ingestion.
 *
 * When a cron job has an entry in `cron_job_bindings`, its output should
 * land in the bound `app_session`'s chat history rather than fan out via
 * the legacy markdown push notification path. This module performs that
 * translation:
 *
 *   markdown file on disk
 *      ↓
 *   synthetic user.message ("▼ Scheduled run · <ts>")
 *   synthetic assistant.message (the markdown body verbatim)
 *      ↓
 *   ws_events row (so resume-from-lastEventId picks it up)
 *   chat_history rows (so /sessions/:id/messages returns it)
 *      ↓
 *   live envelope emit (so an open chat screen renders without reload)
 *
 * No Hermes round-trip happens here — Hermes-cron already produced the
 * output. We just reshape it into the chat narrative.
 *
 * Idempotency: each run carries its `outputId` (filename basename) on the
 * persisted payload, and the watcher's existing `lastSeenOutputId`
 * advancement still gates re-fires across watcher restarts.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { appSessions, cronJobBindings } from "../db/schema.js";
import type { AppLogger } from "../logger.js";
import type { GatewayEventEnvelope } from "../ws/envelope.js";
import { appendEvent } from "../ws/event-log.js";
import { appendHistory } from "../ws/chat-history.js";
import type { SubscriberRegistry } from "../ws/subscriber-registry.js";
import type { ChatCompleteNotifier } from "../push/chat-complete.js";

export interface CronBinding {
  cronJobId: string;
  appSessionId: string;
  outputKind: "inbox" | "session";
  notifyOnRun: boolean;
}

export async function lookupCronBinding(
  db: Db,
  cronJobId: string,
): Promise<CronBinding | null> {
  const rows = await db
    .select({
      cronJobId: cronJobBindings.cronJobId,
      appSessionId: cronJobBindings.appSessionId,
      outputKind: cronJobBindings.outputKind,
      notifyOnRun: cronJobBindings.notifyOnRun,
    })
    .from(cronJobBindings)
    .where(eq(cronJobBindings.cronJobId, cronJobId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    cronJobId: row.cronJobId,
    appSessionId: row.appSessionId,
    outputKind: row.outputKind as "inbox" | "session",
    notifyOnRun: row.notifyOnRun === true,
  };
}

export interface RouteCronOutputArgs {
  db: Db;
  binding: CronBinding;
  outputId: string;
  /** Markdown body of the run, as written by Hermes-cron. */
  content: string;
  /** Optional human-readable cron name; falls back to the cron job id. */
  cronName?: string;
  registry?: SubscriberRegistry;
  /**
   * Optional push notifier. When provided AND `binding.notifyOnRun` is true,
   * fires an Expo push to the session-owner's devices. Fires-and-forgets;
   * routing succeeds regardless of push outcome.
   */
  chatCompleteNotifier?: ChatCompleteNotifier;
  log: AppLogger;
}

export async function routeCronOutputToBoundSession(
  args: RouteCronOutputArgs,
): Promise<void> {
  const { db, binding, outputId, content, cronName, registry, log } = args;

  const now = Math.floor(Date.now() / 1000);
  const ranAtIso = new Date(now * 1000).toISOString();

  // Synthetic user.message — gives the chat the Q→A shape readers expect.
  // historyRowToUiRow + chat-store recognise `cronRun: true` and render a
  // divider pill instead of a normal user bubble.
  const userPayload = {
    text: `Scheduled run · ${ranAtIso}`,
    cronRun: true,
    cronJobId: binding.cronJobId,
    cronName,
    outputId,
    ranAt: now,
  };

  // The actual cron output as the assistant turn.
  const assistantPayload = {
    text: content,
    cronRun: true,
    cronJobId: binding.cronJobId,
    cronName,
    outputId,
    ranAt: now,
    status: "complete",
  };

  try {
    // Persist + emit user.message divider.
    const userEnv = await appendEvent(db, {
      appSessionId: binding.appSessionId,
      type: "gateway.user.message",
      payload: userPayload,
    });
    if (registry) registry.emit(binding.appSessionId, userEnv);
    await appendHistory(db, binding.appSessionId, "user.message", userPayload);

    // Persist + emit assistant.message body.
    const assistantEnv = await appendEvent(db, {
      appSessionId: binding.appSessionId,
      type: "message.complete",
      payload: assistantPayload,
    });
    if (registry) registry.emit(binding.appSessionId, assistantEnv);
    await appendHistory(
      db,
      binding.appSessionId,
      "assistant.message",
      assistantPayload,
    );

    // Bump the bound session's updatedAt so it bubbles to the top of the
    // Cron tab's "recent activity" sort.
    await db
      .update(appSessions)
      .set({ updatedAt: now })
      .where(eq(appSessions.id, binding.appSessionId));

    log.info(
      {
        cronJobId: binding.cronJobId,
        appSessionId: binding.appSessionId,
        outputId,
        outputKind: binding.outputKind,
      },
      "cron output routed to bound session",
    );

    // Fire-and-forget push notification when this binding opted in. The
    // chat-complete-notifier respects the user-wide notifyChatComplete pref
    // AND a 5s minimum duration — we pass a synthetic durationMs over the
    // threshold so the gate is purely the per-cron + user-pref toggle.
    if (args.chatCompleteNotifier && binding.notifyOnRun) {
      void args.chatCompleteNotifier
        .maybePush({
          appSessionId: binding.appSessionId,
          durationMs: 6_000,
          payload: assistantPayload,
        })
        .catch((err: unknown) =>
          log.warn(
            { err, cronJobId: binding.cronJobId },
            "cron-route push notify failed",
          ),
        );
    }
  } catch (err) {
    log.error(
      { err, cronJobId: binding.cronJobId, outputId },
      "failed to route cron output to bound session",
    );
    throw err;
  }
}

// Convenience: combine binding lookup with routing. Returns true when the
// cron had a binding and was routed; false when there's no binding (caller
// should fall through to the legacy markdown push path).
export async function maybeRouteCronOutput(args: {
  db: Db;
  cronJobId: string;
  outputId: string;
  content: string;
  cronName?: string;
  registry?: SubscriberRegistry;
  chatCompleteNotifier?: ChatCompleteNotifier;
  log: AppLogger;
}): Promise<boolean> {
  const binding = await lookupCronBinding(args.db, args.cronJobId);
  if (!binding) return false;

  // Defensive: confirm the bound session still exists. Shouldn't happen with
  // the cascade-delete FK in place, but if a manual intervention removed the
  // session without the binding row, fall back to legacy push so the cron
  // output isn't silently swallowed.
  const sessionRows = await args.db
    .select({ id: appSessions.id })
    .from(appSessions)
    .where(
      and(
        eq(appSessions.id, binding.appSessionId),
        eq(appSessions.kind, binding.outputKind === "inbox" ? "cron_inbox" : "user"),
      ),
    )
    .limit(1);
  if (sessionRows.length === 0) {
    args.log.warn(
      { cronJobId: args.cronJobId, appSessionId: binding.appSessionId },
      "cron binding points at a missing session; falling back to legacy push",
    );
    return false;
  }

  await routeCronOutputToBoundSession({
    db: args.db,
    binding,
    outputId: args.outputId,
    content: args.content,
    ...(args.cronName !== undefined ? { cronName: args.cronName } : {}),
    ...(args.registry ? { registry: args.registry } : {}),
    ...(args.chatCompleteNotifier
      ? { chatCompleteNotifier: args.chatCompleteNotifier }
      : {}),
    log: args.log,
  });
  return true;
}
