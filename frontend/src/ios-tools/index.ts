/**
 * ios-tools mobile bridge — public surface.
 *
 * WS integration:
 *   import { IosToolsHandler } from "@/ios-tools";
 *   const handler = new IosToolsHandler({ sendFrame });
 *   handler.onIncomingFrame(parsedFrame); // returns true if handled
 *
 * Debug / direct invocation:
 *   import { callTool } from "@/ios-tools";
 *   const result = await callTool("ios.calendar.list_events", { startMs, endMs });
 */

export { IosToolsHandler } from "./handler";
export type { IosToolsHandlerDeps } from "./handler";

export { callTool } from "./client";

export { ensurePermission, resetPermissionCache, IosToolPermissionError } from "./permissions";

export type {
  IosToolCallFrame,
  IosToolErrorCode,
  IosToolName,
  IosToolResultFrame,
  PermissionCategory,
} from "./types";
