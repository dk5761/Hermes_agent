// Chat-complete push notifier.
//
// Fires an Expo push notification to every registered device for the session
// owner when an LLM run finishes, provided:
//   1. The run took longer than MIN_DURATION_MS_FOR_PUSH (5 s) — short runs
//      finish before the user's attention has shifted, so a push is noise.
//   2. The user's notifyChatComplete pref is enabled (default = on; a missing
//      row counts as enabled so new users get the feature without a bootstrap).
//
// Best-effort: the caller should fire-and-forget with a `.catch` log guard
// so notification failures never interrupt the event relay pipeline.

import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { appSessions, pushTokens, userPrefs } from "../db/schema.js";
import type { ExpoClient } from "./expo-client.js";
import type { AppLogger } from "../logger.js";
import type { PushPayload } from "./types.js";

const MIN_DURATION_MS_FOR_PUSH = 5_000;
const PREVIEW_MAX_CHARS = 80;

export interface MaybePushArgs {
  appSessionId: string;
  durationMs: number;
  // The message.complete payload from Hermes. May be null/undefined for
  // interrupted or error runs; we extract `.text` if it is a string.
  payload: unknown;
}

export class ChatCompleteNotifier {
  private readonly db: Db;
  private readonly expo: ExpoClient;
  private readonly log: AppLogger;

  constructor(deps: { db: Db; expo: ExpoClient; logger: AppLogger }) {
    this.db = deps.db;
    this.expo = deps.expo;
    this.log = deps.logger.child({ component: "chat-complete-notifier" });
  }

  async maybePush(args: MaybePushArgs): Promise<void> {
    if (args.durationMs < MIN_DURATION_MS_FOR_PUSH) return;

    // Resolve the user owning this session.
    const sessionRows = await this.db
      .select({ userId: appSessions.userId, title: appSessions.titleOverride })
      .from(appSessions)
      .where(eq(appSessions.id, args.appSessionId))
      .limit(1);
    const session = sessionRows[0];
    if (!session) return;

    // Check user pref. Default = enabled (no row OR row.notifyChatComplete = 1).
    const prefRows = await this.db
      .select({ enabled: userPrefs.notifyChatComplete })
      .from(userPrefs)
      .where(eq(userPrefs.userId, session.userId))
      .limit(1);
    const enabled = prefRows.length === 0 || prefRows[0]?.enabled === 1;
    if (!enabled) return;

    // Fetch all push tokens for this user.
    const tokens = await this.db
      .select({ token: pushTokens.expoToken })
      .from(pushTokens)
      .where(eq(pushTokens.userId, session.userId));
    if (tokens.length === 0) return;

    // Extract a body preview from the assistant text. The payload may be
    // null/undefined for interrupted runs; use a sensible fallback.
    let preview = "";
    if (args.payload && typeof args.payload === "object") {
      const text = (args.payload as Record<string, unknown>).text;
      if (typeof text === "string") preview = text.trim();
    }
    if (preview.length === 0) preview = "Tap to view the response";
    if (preview.length > PREVIEW_MAX_CHARS) {
      preview = preview.slice(0, PREVIEW_MAX_CHARS).trim() + "…";
    }
    const title = session.title?.trim() || "Hermes";

    const payloads: PushPayload[] = tokens.map((t) => ({
      to: t.token,
      title,
      body: preview,
      sound: "default" as const,
      data: {
        type: "chat_complete" as const,
        appSessionId: args.appSessionId,
      },
    }));

    try {
      const result = await this.expo.sendMany(payloads);
      this.log.info(
        {
          appSessionId: args.appSessionId,
          ok: result.okCount,
          err: result.errorCount,
          stale: result.staleTokens.length,
        },
        "chat-complete push fanout",
      );
      // Prune stale tokens (DeviceNotRegistered).
      for (const stale of result.staleTokens) {
        await this.db.delete(pushTokens).where(eq(pushTokens.expoToken, stale));
      }
    } catch (err) {
      this.log.warn({ err }, "chat-complete push failed");
    }
  }
}
