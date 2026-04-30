// Wire format definitions — must match backend src/ws/envelope.ts and
// src/ws/gateway-ws.ts exactly. Server sends two kinds of frames:
// 1. GatewayEventEnvelope — has numeric `id`, replayable.
// 2. Control frame — { type: "gateway.ready" | "sync.required" | "ack" | "control.error", payload?: unknown }.

export interface GatewayEventEnvelope<T = unknown> {
  id: number;
  sessionId: string;
  type: string;
  createdAt: string;
  payload: T;
}

export type ControlFrameType =
  | "gateway.ready"
  | "sync.required"
  | "ack"
  | "control.error";

export interface ControlFrame {
  type: ControlFrameType;
  payload?: unknown;
}

// Outbound frames the gateway accepts (see clientFrameSchema in gateway-ws.ts).
export type ClientFrame =
  | { type: "resume"; lastEventId: number }
  | { type: "chat.send"; text: string; attachmentIds?: string[] }
  | { type: "chat.abort" }
  | { type: "approval.respond"; requestId: string; choice: string; all?: boolean }
  | { type: "clarify.respond"; requestId: string; text: string }
  | { type: "sudo.respond"; requestId: string; choice: string }
  | { type: "secret.respond"; requestId: string; value: string }
  | { type: "image.attach"; uploadId: string }
  | { type: "ping" };

// Subset of Hermes event types that the chat reducer handles.
// Source of truth: backend src/ws/event-log.ts PERSISTED_EVENT_TYPES.
export const CHAT_EVENT_TYPES = [
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
  "error",
  "session.info",
  "background.complete",
] as const;
export type ChatEventType = (typeof CHAT_EVENT_TYPES)[number];

export function isEnvelope(v: unknown): v is GatewayEventEnvelope {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["id"] === "number" &&
    typeof o["type"] === "string" &&
    typeof o["createdAt"] === "string"
  );
}

export function isControlFrame(v: unknown): v is ControlFrame {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o["type"] !== "string") return false;
  return (
    o["type"] === "gateway.ready" ||
    o["type"] === "sync.required" ||
    o["type"] === "ack" ||
    o["type"] === "control.error"
  );
}
