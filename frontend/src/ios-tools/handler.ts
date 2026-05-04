/**
 * IosToolsHandler — WS-side bridge.
 *
 * Receives raw incoming WS frames, identifies `ios_tool_call` frames,
 * dispatches to the native module, and sends `ios_tool_result` back over
 * the same WS connection via the injected `sendFrame` function.
 *
 * Contract:
 *  - onIncomingFrame(raw) returns true  → frame was ours (handled or malformed)
 *  - onIncomingFrame(raw) returns false → frame belongs to another handler
 *
 * Guarantees:
 *  - Never throws. Every error path sends a result frame with ok=false.
 *  - Never blocks other frames (each dispatch is a floating Promise).
 */

import IosTools from "ios-tools";
import type { IosToolsNativeModule } from "ios-tools";
import type {
  AddEventArgs,
  AddReminderArgs,
  CompleteReminderArgs,
  DeleteEventArgs,
  ListEventsArgs,
  ListRemindersArgs,
  RunShortcutArgs,
  SendLocalNotificationArgs,
} from "../../modules/ios-tools/src/types";
import { ensurePermission, IosToolPermissionError } from "./permissions";
import type {
  IosToolCallFrame,
  IosToolErrorCode,
  IosToolName,
  IosToolResultFrame,
  PermissionCategory,
} from "./types";

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;

// ─── Deps interface ───────────────────────────────────────────────────────────

export interface IosToolsHandlerDeps {
  /**
   * The WS send function (already established in the app's gateway WS layer).
   * Accepts a serialized frame string and queues it to the open WS.
   */
  sendFrame: (frame: string) => void;
  /** Optional logger. Falls back to a no-op when omitted. */
  log?: (
    level: "info" | "warn" | "error",
    msg: string,
    ctx?: Record<string, unknown>,
  ) => void;
}

// ─── Tool dispatch table ──────────────────────────────────────────────────────

/**
 * Maps each IosToolName to (a) the required PermissionCategory (or null for
 * no-permission tools) and (b) the native dispatch function.
 */
type DispatchEntry = {
  permission: PermissionCategory | null;
  dispatch: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

function buildDispatchTable(): Record<IosToolName, DispatchEntry> {
  // Helper: cast args to a specific type. The args come from a trusted
  // gateway so we trust the shape; strict casts keep TypeScript happy.
  function cast<T>(args: Record<string, unknown>): T {
    return args as unknown as T;
  }

  const module: IosToolsNativeModule = IosTools;

  return {
    "ios.calendar.add_event": {
      permission: "calendar",
      dispatch: async (args) => {
        const result = await module.addEvent(cast<AddEventArgs>(args));
        return result as unknown as Record<string, unknown>;
      },
    },
    "ios.calendar.delete_event": {
      permission: "calendar",
      dispatch: async (args) => {
        const result = await module.deleteEvent(cast<DeleteEventArgs>(args));
        return result as unknown as Record<string, unknown>;
      },
    },
    "ios.calendar.list_events": {
      permission: "calendar",
      dispatch: async (args) => {
        const events = await module.listEvents(cast<ListEventsArgs>(args));
        return { events } as Record<string, unknown>;
      },
    },
    "ios.reminders.add": {
      permission: "reminders",
      dispatch: async (args) => {
        const result = await module.addReminder(cast<AddReminderArgs>(args));
        return result as unknown as Record<string, unknown>;
      },
    },
    "ios.reminders.complete": {
      permission: "reminders",
      dispatch: async (args) => {
        const result = await module.completeReminder(
          cast<CompleteReminderArgs>(args),
        );
        return result as unknown as Record<string, unknown>;
      },
    },
    "ios.reminders.list": {
      permission: "reminders",
      dispatch: async (args) => {
        const reminders = await module.listReminders(
          cast<ListRemindersArgs>(args),
        );
        return { reminders } as Record<string, unknown>;
      },
    },
    "ios.notification.send": {
      permission: "notifications",
      dispatch: async (args) => {
        const result = await module.sendLocalNotification(
          cast<SendLocalNotificationArgs>(args),
        );
        return result as unknown as Record<string, unknown>;
      },
    },
    "ios.shortcut.run": {
      // No permission required in v1 — the shortcut URL scheme doesn't need
      // a separate permission gate. The OS will switch to Shortcuts.app.
      permission: null,
      dispatch: async (args) => {
        const result = await module.runShortcut(cast<RunShortcutArgs>(args));
        return result as unknown as Record<string, unknown>;
      },
    },
  };
}

// Build once at module load time — safe because IosTools is a singleton.
const DISPATCH_TABLE = buildDispatchTable();

// ─── Validation helpers ───────────────────────────────────────────────────────

function isIosToolName(v: unknown): v is IosToolName {
  return (
    typeof v === "string" &&
    (v === "ios.calendar.add_event" ||
      v === "ios.calendar.list_events" ||
      v === "ios.calendar.delete_event" ||
      v === "ios.reminders.add" ||
      v === "ios.reminders.list" ||
      v === "ios.reminders.complete" ||
      v === "ios.notification.send" ||
      v === "ios.shortcut.run")
  );
}

/**
 * Type-guard for a well-formed IosToolCallFrame.
 * Validates every required field; args only needs to be a non-null object.
 */
function isIosToolCallFrame(v: unknown): v is IosToolCallFrame {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    o["type"] === "ios_tool_call" &&
    typeof o["call_id"] === "string" &&
    o["call_id"].length > 0 &&
    isIosToolName(o["tool"]) &&
    o["args"] !== null &&
    typeof o["args"] === "object" &&
    !Array.isArray(o["args"]) &&
    typeof o["timeout_ms"] === "number"
  );
}

// ─── Native error normalisation ───────────────────────────────────────────────

/**
 * Normalises an error thrown by the native module into a canonical
 * IosToolErrorCode + message pair.
 *
 * Native module throws errors with a `.code` property:
 *   permissionDenied → permission_denied
 *   notFound         → unknown  (message includes "not found")
 *   unsupported      → unknown  (message includes "unsupported")
 *   unknown          → unknown
 */
function normaliseNativeError(err: unknown): {
  code: IosToolErrorCode;
  message: string;
} {
  if (err instanceof IosToolPermissionError) {
    return { code: "permission_denied", message: err.message };
  }

  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    const nativeCode = e["code"];
    const rawMsg =
      typeof e["message"] === "string" ? e["message"] : String(err);

    if (nativeCode === "permissionDenied") {
      return { code: "permission_denied", message: rawMsg };
    }
    if (nativeCode === "notFound") {
      return {
        code: "unknown",
        message: `not found: ${rawMsg}`,
      };
    }
    if (nativeCode === "unsupported") {
      return {
        code: "unknown",
        message: `unsupported: ${rawMsg}`,
      };
    }
    // generic "unknown" code or any other code
    return { code: "unknown", message: rawMsg };
  }

  return { code: "unknown", message: String(err) };
}

// ─── IosToolsHandler class ────────────────────────────────────────────────────

export class IosToolsHandler {
  private readonly sendFrame: IosToolsHandlerDeps["sendFrame"];
  private readonly log: NonNullable<IosToolsHandlerDeps["log"]>;

  constructor(deps: IosToolsHandlerDeps) {
    this.sendFrame = deps.sendFrame;
    this.log = deps.log ?? ((_level, _msg, _ctx) => undefined);
  }

  /**
   * Call when an incoming WS frame arrives.
   *
   * @returns true  if this handler claimed the frame (even if dispatch failed).
   * @returns false if the frame is not an ios_tool_call (let other handlers run).
   */
  onIncomingFrame(rawFrame: unknown): boolean {
    // Step 1: quick type discriminant — don't log, just return false.
    if (
      !rawFrame ||
      typeof rawFrame !== "object" ||
      (rawFrame as Record<string, unknown>)["type"] !== "ios_tool_call"
    ) {
      return false;
    }

    // Step 2: full validation.
    if (!isIosToolCallFrame(rawFrame)) {
      this.log("warn", "ios-tools: malformed ios_tool_call frame — ignoring", {
        frame: rawFrame,
      });
      // Claim the frame so no other handler wastes time on it.
      return true;
    }

    // Step 3: dispatch asynchronously. Errors are caught inside and sent
    // as ios_tool_result frames — never propagated to the WS loop.
    void this.dispatchFrame(rawFrame);
    return true;
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private async dispatchFrame(frame: IosToolCallFrame): Promise<void> {
    const { call_id, tool, args, timeout_ms } = frame;
    const effectiveTimeout =
      typeof timeout_ms === "number" && timeout_ms > 0
        ? timeout_ms
        : DEFAULT_TIMEOUT_MS;

    this.log("info", `ios-tools: dispatching ${tool}`, { call_id });

    try {
      const entry = DISPATCH_TABLE[tool];

      // Step 4: permission check.
      if (entry.permission !== null) {
        await ensurePermission(entry.permission);
      }

      // Step 5: race native call against timeout.
      const result = await Promise.race([
        entry.dispatch(args),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                Object.assign(new Error(`ios-tools: ${tool} timed out`), {
                  code: "__timeout__",
                }),
              ),
            effectiveTimeout,
          ),
        ),
      ]);

      // Step 6: success.
      this.log("info", `ios-tools: ${tool} succeeded`, { call_id });
      this.sendResult({
        type: "ios_tool_result",
        call_id,
        ok: true,
        result,
      });
    } catch (err: unknown) {
      // Distinguish timeout sentinel from other errors.
      const isTimeout =
        err !== null &&
        typeof err === "object" &&
        (err as Record<string, unknown>)["code"] === "__timeout__";

      if (isTimeout) {
        this.log("warn", `ios-tools: ${tool} timed out`, {
          call_id,
          timeout_ms: effectiveTimeout,
        });
        this.sendResult({
          type: "ios_tool_result",
          call_id,
          ok: false,
          error: {
            code: "timeout",
            message: `tool "${tool}" did not respond within ${effectiveTimeout}ms`,
          },
        });
        return;
      }

      // Step 7: normalise native / permission errors.
      const { code, message } = normaliseNativeError(err);
      this.log("error", `ios-tools: ${tool} failed`, {
        call_id,
        code,
        message,
      });
      this.sendResult({
        type: "ios_tool_result",
        call_id,
        ok: false,
        error: { code, message },
      });
    }
  }

  private sendResult(frame: IosToolResultFrame): void {
    try {
      this.sendFrame(JSON.stringify(frame));
    } catch (err: unknown) {
      // If we can't even serialize/send the result frame, log and give up.
      // This must not throw — we are already in the error-handling path.
      this.log("error", "ios-tools: failed to send result frame", {
        err: String(err),
      });
    }
  }
}
