/**
 * ios-tools types for the mobile-side WS bridge.
 *
 * IosToolName and the frame shapes are copied verbatim from
 * backend/src/types/ios-tools.ts so the wire format stays in sync.
 * Do not diverge from those definitions — they are the contract.
 */

// ─── Tool names ──────────────────────────────────────────────────────────────

export type IosToolName =
  | "ios.calendar.add_event"
  | "ios.calendar.list_events"
  | "ios.calendar.delete_event"
  | "ios.reminders.add"
  | "ios.reminders.list"
  | "ios.reminders.complete"
  | "ios.notification.send"
  | "ios.shortcut.run";

// ─── Error codes ─────────────────────────────────────────────────────────────

/**
 * Subset of backend IosToolErrorCode relevant on the mobile side.
 * Must remain a subset of the backend's canonical list.
 *
 * - permission_denied: iOS returned a permission error for this tool category.
 * - timeout:           native call did not resolve within timeout_ms.
 * - unknown:           catch-all for unexpected native errors.
 */
export type IosToolErrorCode = "permission_denied" | "timeout" | "unknown";

// ─── WS frame shapes (must match backend/src/types/ios-tools.ts exactly) ─────

/**
 * Received from the gateway (gateway → mobile).
 * Validated by IosToolsHandler before dispatch.
 */
export interface IosToolCallFrame {
  type: "ios_tool_call";
  call_id: string;
  tool: IosToolName;
  args: Record<string, unknown>;
  timeout_ms: number;
}

/**
 * Sent back to the gateway (mobile → gateway).
 * Discriminated union: ok=true carries result, ok=false carries error.
 */
export type IosToolResultFrame =
  | {
      type: "ios_tool_result";
      call_id: string;
      ok: true;
      result: Record<string, unknown>;
    }
  | {
      type: "ios_tool_result";
      call_id: string;
      ok: false;
      error: {
        code: IosToolErrorCode;
        message: string;
      };
    };

// ─── Permission categories ────────────────────────────────────────────────────

export type PermissionCategory = "calendar" | "reminders" | "notifications";
