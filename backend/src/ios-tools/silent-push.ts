// Silent-wake APNs push for iOS native tool calls.
//
// When the user's mobile app WS is not connected, the gateway sends a silent
// push to wake the app into background execution. iOS gives the app ~30s to
// reconnect WS and process the queued tool call.
//
// We send via the Expo push API with _contentAvailable=true, which Expo
// translates to APNs `content-available: 1` + `apns-priority: 5` (silent
// budget). The push_tokens table stores Expo tokens — raw APNs device tokens
// are not tracked separately in this codebase.
//
// Best-effort: errors are logged but never thrown so the caller can proceed
// to the queue fallback.

import { Expo } from "expo-server-sdk";
import type { ExpoPushMessage } from "expo-server-sdk";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { pushTokens } from "../db/schema.js";
import type { AppLogger } from "../logger.js";

export interface SilentPushDeps {
  db: Db;
  logger: AppLogger;
  // Optional access token — same semantics as ExpoClient constructor.
  expoAccessToken?: string | undefined;
}

export class SilentPusher {
  private readonly db: Db;
  private readonly log: AppLogger;
  private readonly expo: Expo;

  constructor(deps: SilentPushDeps) {
    this.db = deps.db;
    this.log = deps.logger.child({ component: "ios-tools-silent-push" });
    this.expo = new Expo(
      deps.expoAccessToken !== undefined ? { accessToken: deps.expoAccessToken } : {},
    );
  }

  /**
   * Fire a content-available:1 silent push to every registered Expo push
   * token for `userId`. Resolves when all pushes are dispatched (or fail).
   * Never rejects — errors are logged and swallowed.
   */
  async sendSilentWake(userId: string): Promise<void> {
    let tokens: Array<{ expoToken: string }>;
    try {
      tokens = await this.db
        .select({ expoToken: pushTokens.expoToken })
        .from(pushTokens)
        .where(eq(pushTokens.userId, userId));
    } catch (err) {
      this.log.warn({ err, userId }, "ios-tools silent push: token lookup failed");
      return;
    }

    if (tokens.length === 0) {
      this.log.info({ userId }, "ios-tools silent push: no tokens registered");
      return;
    }

    const messages: ExpoPushMessage[] = tokens
      .filter((t) => Expo.isExpoPushToken(t.expoToken))
      .map((t): ExpoPushMessage => ({
        to: t.expoToken,
        // Silent push — omit title/body/sound so no visible notification
        // is shown. _contentAvailable instructs Expo to set
        // content-available:1 on the APNs payload.
        _contentAvailable: true,
        // TTL=0: expire immediately if not delivered. We have the server-
        // side queue as a fallback; stale wakes are useless.
        ttl: 0,
        data: { type: "ios_tool_wake" },
      }));

    if (messages.length === 0) {
      this.log.warn({ userId, total: tokens.length }, "ios-tools silent push: no valid expo tokens");
      return;
    }

    const chunks = this.expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      try {
        const tickets = await this.expo.sendPushNotificationsAsync(chunk);
        for (const ticket of tickets) {
          if (ticket.status === "error") {
            this.log.warn(
              { userId, error: ticket.message },
              "ios-tools silent push ticket error",
            );
          }
        }
      } catch (err) {
        this.log.warn({ err, userId }, "ios-tools silent push chunk send failed");
      }
    }

    this.log.info({ userId, sent: messages.length }, "ios-tools silent push dispatched");
  }
}
