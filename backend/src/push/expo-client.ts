// Thin typed wrapper around expo-server-sdk.
//
// Responsibilities:
// - Validate Expo push tokens at registration time.
// - Chunk and send push messages, returning a typed PushSendResult.
// - Surface DeviceNotRegistered tokens so the caller can prune the DB.
//
// Receipt polling is intentionally not implemented inline. Per Expo's docs
// receipts should be fetched after ~15min from a worker that survives process
// restarts; that's deferred to Phase 7. Tickets with non-ok status are logged.

import { Expo } from "expo-server-sdk";
import type { ExpoPushMessage, ExpoPushTicket } from "expo-server-sdk";
import type { AppLogger } from "../logger.js";
import type { PushPayload, PushSendResult } from "./types.js";

export interface ExpoClientDeps {
  accessToken: string | undefined;
  logger: AppLogger;
}

export class ExpoClient {
  private readonly expo: Expo;
  private readonly log: AppLogger;

  constructor(deps: ExpoClientDeps) {
    this.expo = new Expo(
      deps.accessToken !== undefined ? { accessToken: deps.accessToken } : {},
    );
    this.log = deps.logger.child({ component: "expo-client" });
  }

  // Validate a token format. Cheap synchronous check — no network call.
  static isValidToken(token: string): boolean {
    return Expo.isExpoPushToken(token);
  }

  async sendMany(payloads: ReadonlyArray<PushPayload>): Promise<PushSendResult> {
    const result: PushSendResult = { staleTokens: [], okCount: 0, errorCount: 0 };
    if (payloads.length === 0) return result;

    // Filter invalid tokens up-front; treat them as stale so callers prune.
    const valid: ExpoPushMessage[] = [];
    for (const p of payloads) {
      // SDK's type predicate narrows the false branch to never; capture the
      // raw string before the guard so we can still log/return it.
      const rawToken: string = p.to;
      if (!Expo.isExpoPushToken(p.to)) {
        this.log.warn({ token: rawToken.slice(0, 12) + "…" }, "skipping invalid expo token");
        result.staleTokens.push(rawToken);
        result.errorCount += 1;
        continue;
      }
      valid.push({
        to: p.to,
        title: p.title,
        body: p.body,
        data: p.data as unknown as Record<string, unknown>,
        // Omit `sound` if not provided — Expo default behavior.
        ...(p.sound !== undefined ? { sound: p.sound } : {}),
      });
    }
    if (valid.length === 0) return result;

    const chunks = this.expo.chunkPushNotifications(valid);
    const tickets: ExpoPushTicket[] = [];
    for (const chunk of chunks) {
      try {
        const part = await this.expo.sendPushNotificationsAsync(chunk);
        tickets.push(...part);
      } catch (err) {
        // Network/transport failure for a whole chunk. We don't know which
        // tokens failed individually, so just count and log.
        result.errorCount += chunk.length;
        this.log.error({ err, count: chunk.length }, "expo chunk send failed");
      }
    }

    for (let i = 0; i < tickets.length; i += 1) {
      const ticket = tickets[i];
      const message = valid[i];
      if (!ticket || !message) continue;
      if (ticket.status === "ok") {
        result.okCount += 1;
        continue;
      }
      result.errorCount += 1;
      // Distinguish stale tokens from transient errors. Expo's documented
      // permanent-failure code is DeviceNotRegistered.
      const errorCode = ticket.details?.error;
      if (errorCode === "DeviceNotRegistered") {
        result.staleTokens.push(message.to as string);
      } else {
        this.log.warn(
          { errorCode, message: ticket.message },
          "expo ticket non-ok",
        );
      }
    }
    return result;
  }
}
