// Shared types for the iOS native tools WS bridge.
//
// These types describe the wire frames exchanged between the gateway and the
// mobile app's ios-tools-handler, as well as the error model surfaced to the
// MCP stdio server via POST /internal/ios-tool.

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

// ─── WS frame types (gateway ↔ mobile) ───────────────────────────────────────

/**
 * Sent gateway → mobile to invoke a native tool.
 * The mobile app's ios-tools-handler dispatches to the native module,
 * then sends back an IosToolResultFrame.
 */
export interface IosToolCallFrame {
  type: "ios_tool_call";
  /** UUID used to correlate the response. */
  call_id: string;
  tool: IosToolName;
  args: Record<string, unknown>;
  timeout_ms: number;
}

/**
 * Sent mobile → gateway with the native tool's result (or error).
 */
export interface IosToolResultFrame {
  type: "ios_tool_result";
  /** Must match the call_id from the originating IosToolCallFrame. */
  call_id: string;
  ok: boolean;
  result?: Record<string, unknown> | undefined;
  /**
   * error.code is `string` here (not narrowed to IosToolErrorCode) because
   * the mobile app may send any code and we validate/map it in the router.
   */
  error?: {
    code: string;
    message: string;
  } | undefined;
}

// ─── Error codes ─────────────────────────────────────────────────────────────

/**
 * Canonical error codes used in IosToolError and surfaced by the
 * MCP stdio server as { ok: false, error: { code, message } }.
 *
 * - offline:           phone is unreachable and NOT queued (definitively failed)
 * - queued:            call persisted server-side; will fire on next reconnect
 * - timeout:           WS was open but tool did not respond within timeoutMs
 * - permission_denied: iOS returned a permission error for this tool category
 * - unknown:           catch-all for unexpected native errors
 */
export type IosToolErrorCode =
  | "offline"
  | "queued"
  | "timeout"
  | "permission_denied"
  | "unknown";

// ─── Error class ─────────────────────────────────────────────────────────────

export class IosToolError extends Error {
  readonly code: IosToolErrorCode;

  constructor(code: IosToolErrorCode, message: string) {
    super(message);
    this.name = "IosToolError";
    this.code = code;
  }
}
