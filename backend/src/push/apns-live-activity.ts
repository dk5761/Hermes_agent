/**
 * Thin wrapper around `@parse/node-apn` for ActivityKit push updates.
 *
 * Two payload shapes:
 *   - update : `{ aps: { event: "update", "content-state": {...}, "stale-date": ... } }`
 *   - end    : `{ aps: { event: "end",    "content-state": {...}, "dismissal-date": ... } }`
 *
 * Headers required by APNs for live activities:
 *   apns-push-type: liveactivity
 *   apns-topic:     <bundleId>.push-type.liveactivity
 *   apns-priority:  10
 *
 * If any APNs credential is missing, all calls become no-ops and the
 * gateway logs a warning once on first use. Foreground updates from the
 * JS bridge keep working in that mode — only background updates break.
 */
import apn from "@parse/node-apn";
import type { AppLogger } from "../logger.js";

interface ConfigSlice {
  APNS_KEY_ID?: string | undefined;
  APNS_TEAM_ID?: string | undefined;
  APNS_BUNDLE_ID?: string | undefined;
  APNS_KEY_P8?: string | undefined;
  APNS_USE_SANDBOX: boolean;
}

interface DepsLike {
  config: ConfigSlice;
  logger: AppLogger;
}

export interface LiveActivityContentState {
  kind: "chat" | "approval";
  status: "thinking" | "tool" | "responding" | "awaiting";
  detail: string | null;
  // Wall-clock start of the run. Widget uses SwiftUI's `Text(timerInterval:)`
  // to auto-tick on-device — no per-second updates needed.
  startedAtEpochMs: number;
  modelName: string | null;
  updatedAtEpochMs: number;
  openUrl: string | null;
}

export class LiveActivityPusher {
  private readonly log: AppLogger;
  private readonly bundleId: string | null;
  private readonly provider: apn.Provider | null;
  private warnedDisabled = false;

  constructor(deps: DepsLike) {
    this.log = deps.logger.child({ component: "apns-live-activity" });
    this.bundleId = deps.config.APNS_BUNDLE_ID ?? null;

    const haveAll =
      deps.config.APNS_KEY_ID &&
      deps.config.APNS_TEAM_ID &&
      deps.config.APNS_BUNDLE_ID &&
      deps.config.APNS_KEY_P8;
    if (!haveAll) {
      this.provider = null;
      return;
    }
    let key: string = deps.config.APNS_KEY_P8 ?? "";
    // Accept base64 OR raw .p8 contents.
    if (!/-----BEGIN/i.test(key)) {
      try {
        key = Buffer.from(key, "base64").toString("utf8");
      } catch {
        // leave as-is; node-apn will error on send
      }
    }
    try {
      this.provider = new apn.Provider({
        token: {
          key,
          keyId: deps.config.APNS_KEY_ID!,
          teamId: deps.config.APNS_TEAM_ID!,
        },
        production: !deps.config.APNS_USE_SANDBOX,
      });
    } catch (err) {
      this.log.warn({ err }, "apns provider init failed; pushes disabled");
      this.provider = null;
    }
  }

  isEnabled(): boolean {
    return !!this.provider && !!this.bundleId;
  }

  async sendUpdate(
    pushToken: string,
    state: LiveActivityContentState,
    opts: { staleAfterSec?: number } = {},
  ): Promise<void> {
    if (!this.isEnabled()) {
      this.warnDisabledOnce();
      return;
    }
    const note = this.makeNote("update", state, opts);
    await this.dispatch(pushToken, note);
  }

  async sendEnd(
    pushToken: string,
    finalState: LiveActivityContentState,
    opts: { dismissAfterSec?: number } = {},
  ): Promise<void> {
    if (!this.isEnabled()) {
      this.warnDisabledOnce();
      return;
    }
    const note = this.makeNote("end", finalState, {
      dismissAfterSec: opts.dismissAfterSec ?? 0,
    });
    await this.dispatch(pushToken, note);
  }

  private makeNote(
    event: "update" | "end",
    state: LiveActivityContentState,
    opts: { staleAfterSec?: number; dismissAfterSec?: number },
  ): apn.Notification {
    const note = new apn.Notification();
    note.topic = `${this.bundleId}.push-type.liveactivity`;
    note.pushType = "liveactivity" as apn.Notification["pushType"];
    note.priority = 10;
    note.expiry = Math.floor(Date.now() / 1000) + 60 * 60 * 8;
    const aps: Record<string, unknown> = {
      timestamp: Math.floor(Date.now() / 1000),
      event,
      "content-state": state,
    };
    if (opts.staleAfterSec) {
      aps["stale-date"] = Math.floor(Date.now() / 1000) + opts.staleAfterSec;
    }
    if (event === "end") {
      aps["dismissal-date"] =
        Math.floor(Date.now() / 1000) + (opts.dismissAfterSec ?? 0);
    }
    note.payload = { aps };
    return note;
  }

  private async dispatch(token: string, note: apn.Notification): Promise<void> {
    try {
      const res = await this.provider!.send(note, token);
      for (const failure of res.failed) {
        this.log.warn(
          { token, status: failure.status, response: failure.response },
          "apns live-activity push failed",
        );
      }
    } catch (err) {
      this.log.warn({ err }, "apns dispatch threw");
    }
  }

  private warnDisabledOnce(): void {
    if (this.warnedDisabled) return;
    this.warnedDisabled = true;
    this.log.info(
      "APNs live-activity credentials missing — background pushes disabled (foreground updates still work).",
    );
  }

  async close(): Promise<void> {
    this.provider?.shutdown();
  }
}
