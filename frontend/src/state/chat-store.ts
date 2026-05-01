import { create } from "zustand";
import type { GatewayEventEnvelope } from "../ws/events";
import type { AttachmentDTO } from "../api/types";

// Per-session chat state, keyed by app_session_id. Streaming assistant frames
// accumulate into a transient `streaming` blob; on message.complete we push a
// finalized assistant message and clear streaming. This mirrors the Hermes
// event lifecycle (see HERMES_CONTRACT.md §"Streaming a turn").

export type Role = "user" | "assistant" | "system";

export interface UserMessage {
  kind: "user";
  id: string;
  text: string;
  createdAt: string;
  // Live path: full DTOs from the upload pipeline. Persisted with the bubble
  // for the active session so re-renders don't re-fetch.
  attachments?: AttachmentDTO[];
  // Cold-load path: just the IDs from the permanent chat_history payload.
  // The renderer resolves each via getAttachment(id) and caches via TanStack.
  attachmentRefs?: string[];
}

export interface AssistantMessage {
  kind: "assistant";
  id: string;
  text: string;
  reasoning?: string;
  createdAt: string;
  warning?: string;
}

export interface ToolCallCard {
  kind: "tool";
  id: string;
  name: string;
  status: "running" | "complete" | "error";
  // Free-form payload bag for renderer (input, output, progress, error).
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface ErrorBubble {
  kind: "error";
  id: string;
  message: string;
  createdAt: string;
}

export type Message = UserMessage | AssistantMessage | ToolCallCard | ErrorBubble;

export interface ToolCallState {
  id: string;
  name: string;
  status: "running" | "complete" | "error";
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface StreamingAssistant {
  textBuffer: string;
  reasoningBuffer: string;
  toolCalls: Map<string, ToolCallState>;
  startedAt: string;
}

export type ApprovalKind = "approval" | "clarify" | "sudo" | "secret";

export interface ApprovalRequest {
  kind: ApprovalKind;
  requestId: string;
  prompt: string;
  // Free-form passthrough of upstream payload — UI may surface choices etc.
  raw: Record<string, unknown>;
  createdAt: string;
  // True when this row was reconstructed from chat_history and we know the
  // request was already answered (something exists after it in history).
  // Drives the compact "resolved" pill in ApprovalCard.
  resolved?: boolean;
}

export interface ChatSessionState {
  appSessionId: string;
  messages: Message[];
  streaming: StreamingAssistant | null;
  pendingApprovals: ApprovalRequest[];
  lastEventId: number;
  isStreaming: boolean;
}

interface ChatStore {
  byId: Record<string, ChatSessionState>;
  // Per-session: most recent tool_call_id where name === "todo". Drives
  // "isLatest" on TodoPlanCard (footer + pin/add-step UI). Lives outside
  // ChatSessionState so it survives `reset(id)` cold-loads.
  latestTodoToolIdById: Record<string, string | null>;
  ensure: (id: string) => void;
  get: (id: string) => ChatSessionState | undefined;
  reset: (id: string) => void;
  pushUserMessage: (id: string, text: string, attachments?: AttachmentDTO[]) => void;
  applyEnvelope: (id: string, env: GatewayEventEnvelope) => void;
  resolveApproval: (id: string, requestId: string) => void;
  setLatestTodoToolId: (sessionId: string, toolCallId: string | null) => void;
}

const empty = (appSessionId: string): ChatSessionState => ({
  appSessionId,
  messages: [],
  streaming: null,
  pendingApprovals: [],
  lastEventId: 0,
  isStreaming: false,
});

function clone(state: ChatSessionState): ChatSessionState {
  return {
    ...state,
    messages: state.messages.slice(),
    streaming: state.streaming
      ? {
          ...state.streaming,
          toolCalls: new Map(state.streaming.toolCalls),
        }
      : null,
    pendingApprovals: state.pendingApprovals.slice(),
  };
}

function getString(o: unknown, key: string): string | undefined {
  if (!o || typeof o !== "object") return undefined;
  const v = (o as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

function genId(prefix: string): string {
  // Math.random is fine for client-only message keys; not security-sensitive.
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function reduce(state: ChatSessionState, env: GatewayEventEnvelope): ChatSessionState {
  const next = clone(state);
  if (env.id > 0 && env.id > next.lastEventId) next.lastEventId = env.id;

  const payload = env.payload as Record<string, unknown> | null;

  switch (env.type) {
    case "message.start": {
      next.streaming = {
        textBuffer: "",
        reasoningBuffer: "",
        toolCalls: new Map(),
        startedAt: env.createdAt,
      };
      next.isStreaming = true;
      return next;
    }
    case "message.delta":
    case "thinking.delta": {
      if (!next.streaming) {
        next.streaming = {
          textBuffer: "",
          reasoningBuffer: "",
          toolCalls: new Map(),
          startedAt: env.createdAt,
        };
        next.isStreaming = true;
      }
      const chunk =
        getString(payload, "text") ??
        getString(payload, "delta") ??
        getString(payload, "content") ??
        "";
      next.streaming = { ...next.streaming, textBuffer: next.streaming.textBuffer + chunk };
      return next;
    }
    case "reasoning.delta":
    case "reasoning.available": {
      if (!next.streaming) {
        next.streaming = {
          textBuffer: "",
          reasoningBuffer: "",
          toolCalls: new Map(),
          startedAt: env.createdAt,
        };
        next.isStreaming = true;
      }
      const chunk =
        getString(payload, "text") ??
        getString(payload, "delta") ??
        getString(payload, "reasoning") ??
        "";
      next.streaming = {
        ...next.streaming,
        reasoningBuffer: next.streaming.reasoningBuffer + chunk,
      };
      return next;
    }
    case "tool.start":
    case "tool.generating":
    case "tool.update":
    case "tool.progress": {
      const id = getString(payload, "id") ?? getString(payload, "tool_id") ?? genId("tool");
      const name =
        getString(payload, "name") ??
        getString(payload, "tool") ??
        getString(payload, "tool_name") ??
        "tool";
      const existing = next.streaming?.toolCalls.get(id);
      const merged: ToolCallState = {
        id,
        name: existing?.name ?? name,
        status: "running",
        detail: { ...(existing?.detail ?? {}), ...(payload ?? {}) },
        createdAt: existing?.createdAt ?? env.createdAt,
      };
      if (!next.streaming) {
        next.streaming = {
          textBuffer: "",
          reasoningBuffer: "",
          toolCalls: new Map([[id, merged]]),
          startedAt: env.createdAt,
        };
        next.isStreaming = true;
      } else {
        const tc = new Map(next.streaming.toolCalls);
        tc.set(id, merged);
        next.streaming = { ...next.streaming, toolCalls: tc };
      }
      return next;
    }
    case "tool.complete": {
      const id = getString(payload, "id") ?? getString(payload, "tool_id") ?? genId("tool");
      const name =
        getString(payload, "name") ??
        getString(payload, "tool") ??
        getString(payload, "tool_name") ??
        "tool";
      const errStr = getString(payload, "error");
      const existing = next.streaming?.toolCalls.get(id);
      const card: ToolCallCard = {
        kind: "tool",
        id,
        name: existing?.name ?? name,
        status: errStr ? "error" : "complete",
        detail: { ...(existing?.detail ?? {}), ...(payload ?? {}) },
        createdAt: existing?.createdAt ?? env.createdAt,
      };
      next.messages = [...next.messages, card];
      if (next.streaming) {
        const tc = new Map(next.streaming.toolCalls);
        tc.delete(id);
        next.streaming = { ...next.streaming, toolCalls: tc };
      }
      return next;
    }
    case "message.complete": {
      const text =
        getString(payload, "text") ??
        next.streaming?.textBuffer ??
        "";
      const reasoning =
        getString(payload, "reasoning") ?? next.streaming?.reasoningBuffer;
      const warning = getString(payload, "warning");
      const msg: AssistantMessage = {
        kind: "assistant",
        id: `assistant-${env.id > 0 ? env.id : genId("a")}`,
        text,
        reasoning: reasoning && reasoning.length > 0 ? reasoning : undefined,
        warning,
        createdAt: env.createdAt,
      };
      next.messages = [...next.messages, msg];
      next.streaming = null;
      next.isStreaming = false;
      return next;
    }
    case "approval.request":
    case "clarify.request":
    case "sudo.request":
    case "secret.request": {
      const requestId =
        getString(payload, "request_id") ??
        getString(payload, "id") ??
        genId("req");
      const prompt =
        getString(payload, "prompt") ??
        getString(payload, "message") ??
        getString(payload, "question") ??
        "";
      const kind: ApprovalKind = env.type.startsWith("approval")
        ? "approval"
        : env.type.startsWith("clarify")
          ? "clarify"
          : env.type.startsWith("sudo")
            ? "sudo"
            : "secret";
      // Dedupe by requestId — replay on reconnect/sync would otherwise push
      // the same prompt twice.
      if (next.pendingApprovals.some((p) => p.requestId === requestId)) {
        return next;
      }
      const req: ApprovalRequest = {
        kind,
        requestId,
        prompt,
        raw: (payload ?? {}) as Record<string, unknown>,
        createdAt: env.createdAt,
      };
      next.pendingApprovals = [...next.pendingApprovals, req];
      return next;
    }
    case "error": {
      const text =
        getString(payload, "message") ??
        getString(payload, "error") ??
        "Stream error";
      next.messages = [
        ...next.messages,
        {
          kind: "error",
          id: `err-${env.id > 0 ? env.id : genId("e")}`,
          message: text,
          createdAt: env.createdAt,
        },
      ];
      next.streaming = null;
      next.isStreaming = false;
      return next;
    }
    case "session.info":
    case "background.complete":
    case "subagent.start":
    case "subagent.tool":
    case "subagent.complete":
      // Phase 3: surface only as no-op state mutation — id bookkeeping only.
      return next;
    default:
      return next;
  }
}

export const useChatStore = create<ChatStore>((set, get) => ({
  byId: {},
  latestTodoToolIdById: {},

  ensure(id) {
    if (get().byId[id]) return;
    set((s) => ({ byId: { ...s.byId, [id]: empty(id) } }));
  },

  get(id) {
    return get().byId[id];
  },

  reset(id) {
    set((s) => ({ byId: { ...s.byId, [id]: empty(id) } }));
  },

  pushUserMessage(id, text, attachments) {
    set((s) => {
      const cur = s.byId[id] ?? empty(id);
      const msg: UserMessage = {
        kind: "user",
        id: genId("u"),
        text,
        createdAt: new Date().toISOString(),
        attachments: attachments && attachments.length > 0 ? attachments : undefined,
      };
      return {
        byId: {
          ...s.byId,
          [id]: { ...cur, messages: [...cur.messages, msg] },
        },
      };
    });
  },

  applyEnvelope(id, env) {
    set((s) => {
      const cur = s.byId[id] ?? empty(id);
      const nextSession = reduce(cur, env);
      // Bump latest-todo pointer when a tool.complete with name="todo" lands.
      // We read tool_id (the upstream-stable id) rather than fishing it back
      // out of the message we just appended.
      let latest = s.latestTodoToolIdById;
      if (env.type === "tool.complete") {
        const p = env.payload as Record<string, unknown> | null;
        const name = p && typeof p["name"] === "string" ? (p["name"] as string) : null;
        const toolId = p && typeof p["tool_id"] === "string" ? (p["tool_id"] as string) : null;
        if (name === "todo" && toolId) {
          latest = { ...latest, [id]: toolId };
        }
      }
      return {
        byId: { ...s.byId, [id]: nextSession },
        latestTodoToolIdById: latest,
      };
    });
  },

  resolveApproval(id, requestId) {
    set((s) => {
      const cur = s.byId[id];
      if (!cur) return s;
      return {
        byId: {
          ...s.byId,
          [id]: {
            ...cur,
            pendingApprovals: cur.pendingApprovals.filter((p) => p.requestId !== requestId),
          },
        },
      };
    });
  },

  setLatestTodoToolId(sessionId, toolCallId) {
    set((s) => ({
      latestTodoToolIdById: {
        ...s.latestTodoToolIdById,
        [sessionId]: toolCallId,
      },
    }));
  },
}));
