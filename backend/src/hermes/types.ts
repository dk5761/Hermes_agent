// JSON-RPC 2.0 envelope types + Hermes event/method literals.
// Documented from HERMES_CONTRACT.md §"WebSocket: /api/ws (JSON-RPC 2.0)".

import { z } from "zod";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: Record<string, JsonValue>;
}

export interface JsonRpcSuccess<R = JsonValue> {
  jsonrpc: "2.0";
  id: string;
  result: R;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: string;
  error: { code: number; message: string; data?: JsonValue };
}

export type JsonRpcResponse<R = JsonValue> = JsonRpcSuccess<R> | JsonRpcError;

// Server-emitted notification frame. Hermes sends events as JSON-RPC notifications
// with method "event" carrying { type, session_id?, payload }.
export interface JsonRpcEventFrame {
  jsonrpc: "2.0";
  method: "event";
  params: HermesEventParams;
}

export interface HermesEventParams {
  type: string;
  session_id?: string;
  payload?: JsonValue;
}

// Hermes event type literals (subset relevant to mobile).
export const HERMES_EVENT_TYPES = [
  "gateway.ready",
  "session.info",
  "error",
  "status.update",
  "message.start",
  "message.delta",
  "message.complete",
  "thinking.delta",
  "reasoning.delta",
  "reasoning.available",
  "tool.start",
  "tool.generating",
  "tool.update",
  "tool.progress",
  "tool.complete",
  "subagent.start",
  "subagent.tool",
  "subagent.complete",
  "approval.request",
  "clarify.request",
  "sudo.request",
  "secret.request",
  "voice.transcript",
  "voice.status",
  "background.complete",
] as const;
export type HermesEventType = (typeof HERMES_EVENT_TYPES)[number];

// Hermes REST response shapes (subset). Validated with zod at the trust boundary.
export const HermesSessionInfoSchema = z
  .object({
    session_id: z.string(),
    title: z.string().optional(),
    created_at: z.union([z.string(), z.number()]).optional(),
    updated_at: z.union([z.string(), z.number()]).optional(),
    message_count: z.number().int().optional(),
    last_message_preview: z.string().optional(),
  })
  .passthrough();
export type HermesSessionInfo = z.infer<typeof HermesSessionInfoSchema>;

export const HermesSessionListSchema = z
  .object({
    sessions: z.array(HermesSessionInfoSchema),
    total: z.number().int().optional(),
    limit: z.number().int().optional(),
    offset: z.number().int().optional(),
  })
  .passthrough();
export type HermesSessionList = z.infer<typeof HermesSessionListSchema>;

export const HermesMessageSchema = z
  .object({
    role: z.string(),
    content: z.union([z.string(), z.unknown()]).optional(),
  })
  .passthrough();

export const HermesMessagesResponseSchema = z
  .object({
    messages: z.array(HermesMessageSchema),
  })
  .passthrough();
export type HermesMessagesResponse = z.infer<typeof HermesMessagesResponseSchema>;

// Cron job shape — passthrough to keep upstream changes non-breaking.
export const HermesCronJobSchema = z
  .object({
    id: z.string(),
  })
  .passthrough();
export type HermesCronJob = z.infer<typeof HermesCronJobSchema>;

export const HermesCronJobsListSchema = z
  .object({ jobs: z.array(HermesCronJobSchema) })
  .passthrough();

// Errors thrown by Hermes calls — gateway distinguishes auth vs other.
export class HermesAuthError extends Error {
  constructor(message = "hermes_auth_failed") {
    super(message);
    this.name = "HermesAuthError";
  }
}

export class HermesUpstreamError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "HermesUpstreamError";
  }
}

export class HermesRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: JsonValue,
  ) {
    super(message);
    this.name = "HermesRpcError";
  }
}
