import { create, type StoreApi } from "zustand";
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
  // Time the model spent reasoning (first reasoning.delta → first message
  // token, or message.complete if no text streamed). Drives the "Thought
  // for Ns" header in the collapsed reasoning block. Live-only field.
  reasoningDurationMs?: number;
}

// Subtask of a parent `delegate_task` tool call. Hermes emits dedicated
// `subagent.start/complete` events bracketed inside the parent's tool.start
// → tool.complete. The reducer tags each subagent into the currently-open
// delegate_task tool so the UI can render them as a single grouped card.
export interface SubagentInfo {
  subagentId: string;
  taskIndex: number;
  taskCount: number;
  goal: string;
  model?: string;
  toolsets?: string[];
  status: "running" | "completed" | "interrupted" | "error";
  durationSec?: number;
  summary?: string;
}

export interface ToolCallCard {
  kind: "tool";
  id: string;
  name: string;
  status: "running" | "complete" | "error";
  // Free-form payload bag for renderer (input, output, progress, error).
  detail: Record<string, unknown>;
  createdAt: string;
  // Populated only for delegate_task tool calls (parent of N subagents).
  subagents?: SubagentInfo[];
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
  subagents?: SubagentInfo[];
}

export interface StreamingAssistant {
  textBuffer: string;
  reasoningBuffer: string;
  toolCalls: Map<string, ToolCallState>;
  // Tool id of the currently-open delegate_task call; subagent.* events
  // attach to this one. Hermes emits delegations sequentially, so a single
  // open id is sufficient.
  currentDelegateToolId: string | null;
  startedAt: string;
  // Timestamps (ms since epoch) used to compute "Thought for Ns" once the
  // turn completes. `reasoningStartedAt` lands on the first reasoning.delta
  // / reasoning.available; `reasoningEndedAt` lands when the model starts
  // streaming the visible answer (first message.delta) or when the turn
  // completes — whichever is first.
  reasoningStartedAt: number | null;
  reasoningEndedAt: number | null;
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
  // Drop the last turn — every message from the latest user message onwards.
  // Used by Regenerate before re-issuing the prompt so the UI doesn't show
  // both the old and the new responses while the new turn streams in.
  truncateLastTurn: (id: string) => void;
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

function emptyStreaming(startedAt: string): StreamingAssistant {
  return {
    textBuffer: "",
    reasoningBuffer: "",
    toolCalls: new Map(),
    currentDelegateToolId: null,
    startedAt,
    reasoningStartedAt: null,
    reasoningEndedAt: null,
  };
}

function readSubagentInfo(payload: Record<string, unknown> | null): SubagentInfo | null {
  if (!payload) return null;
  const subagentId = getString(payload, "subagent_id");
  if (!subagentId) return null;
  const goal = getString(payload, "goal") ?? "";
  const taskIndex = typeof payload["task_index"] === "number" ? (payload["task_index"] as number) : 0;
  const taskCount = typeof payload["task_count"] === "number" ? (payload["task_count"] as number) : 1;
  const statusStr = getString(payload, "status");
  let status: SubagentInfo["status"] = "running";
  if (statusStr === "completed") status = "completed";
  else if (statusStr === "interrupted") status = "interrupted";
  else if (statusStr === "error") status = "error";
  const durationSec =
    typeof payload["duration_seconds"] === "number"
      ? (payload["duration_seconds"] as number)
      : undefined;
  const summaryRaw = getString(payload, "summary");
  const summary =
    summaryRaw && summaryRaw !== "(empty)" && summaryRaw.length > 0 ? summaryRaw : undefined;
  const model = getString(payload, "model");
  const toolsetsRaw = payload["toolsets"];
  const toolsets = Array.isArray(toolsetsRaw)
    ? toolsetsRaw.filter((v): v is string => typeof v === "string")
    : undefined;
  return {
    subagentId,
    taskIndex,
    taskCount,
    goal,
    status,
    ...(model ? { model } : {}),
    ...(toolsets && toolsets.length > 0 ? { toolsets } : {}),
    ...(durationSec !== undefined ? { durationSec } : {}),
    ...(summary ? { summary } : {}),
  };
}

function reduce(state: ChatSessionState, env: GatewayEventEnvelope): ChatSessionState {
  const next = clone(state);
  if (env.id > 0 && env.id > next.lastEventId) next.lastEventId = env.id;

  const payload = env.payload as Record<string, unknown> | null;

  switch (env.type) {
    case "message.start": {
      next.streaming = emptyStreaming(env.createdAt);
      next.isStreaming = true;
      return next;
    }
    case "thinking.delta":
      // Hermes emits decorative status text on this channel — kaomoji like
      // "(o_o) mulling…" or "( •_•)>⌐■-■ synthesizing…". They're meant for
      // a TUI status line, not the chat bubble. Drop entirely; the live
      // "Thinking…" header in ReasoningInline already conveys the same
      // intent without dumping ASCII art into the response text.
      return next;
    case "message.delta": {
      if (!next.streaming) {
        next.streaming = emptyStreaming(env.createdAt);
        next.isStreaming = true;
      }
      const chunk =
        getString(payload, "text") ??
        getString(payload, "delta") ??
        getString(payload, "content") ??
        "";
      // First message.delta is the moment the model stopped thinking and
      // started answering — record it so we can show "Thought for Ns".
      const nextEndedAt =
        next.streaming.reasoningStartedAt !== null &&
        next.streaming.reasoningEndedAt === null
          ? Date.now()
          : next.streaming.reasoningEndedAt;
      next.streaming = {
        ...next.streaming,
        textBuffer: next.streaming.textBuffer + chunk,
        reasoningEndedAt: nextEndedAt,
      };
      return next;
    }
    case "reasoning.delta":
    case "reasoning.available": {
      if (!next.streaming) {
        next.streaming = emptyStreaming(env.createdAt);
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
        // Stamp the start time on the very first reasoning chunk we see.
        reasoningStartedAt:
          next.streaming.reasoningStartedAt ?? Date.now(),
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
        ...(existing?.subagents ? { subagents: existing.subagents } : {}),
      };
      if (!next.streaming) {
        next.streaming = {
          ...emptyStreaming(env.createdAt),
          toolCalls: new Map([[id, merged]]),
          currentDelegateToolId: name === "delegate_task" && env.type === "tool.start" ? id : null,
        };
        next.isStreaming = true;
      } else {
        const tc = new Map(next.streaming.toolCalls);
        tc.set(id, merged);
        const nextDelegateId =
          name === "delegate_task" && env.type === "tool.start"
            ? id
            : next.streaming.currentDelegateToolId;
        next.streaming = {
          ...next.streaming,
          toolCalls: tc,
          currentDelegateToolId: nextDelegateId,
        };
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
        ...(existing?.subagents ? { subagents: existing.subagents } : {}),
      };
      next.messages = [...next.messages, card];
      if (next.streaming) {
        const tc = new Map(next.streaming.toolCalls);
        tc.delete(id);
        const nextDelegateId =
          next.streaming.currentDelegateToolId === id ? null : next.streaming.currentDelegateToolId;
        next.streaming = {
          ...next.streaming,
          toolCalls: tc,
          currentDelegateToolId: nextDelegateId,
        };
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
      // Duration covers reasoning-start → first text token, falling back to
      // now-completion if no text was streamed (rare). Negative or missing
      // values stay undefined so the UI just shows "Thought" without a
      // duration label.
      let reasoningDurationMs: number | undefined;
      if (next.streaming?.reasoningStartedAt) {
        const end =
          next.streaming.reasoningEndedAt ?? Date.now();
        const ms = end - next.streaming.reasoningStartedAt;
        if (ms > 0) reasoningDurationMs = ms;
      }
      const msg: AssistantMessage = {
        kind: "assistant",
        id: `assistant-${env.id > 0 ? env.id : genId("a")}`,
        text,
        reasoning: reasoning && reasoning.length > 0 ? reasoning : undefined,
        warning,
        createdAt: env.createdAt,
        ...(reasoningDurationMs !== undefined ? { reasoningDurationMs } : {}),
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
    case "subagent.start":
    case "subagent.complete": {
      const info = readSubagentInfo(payload);
      if (!info || !next.streaming) return next;
      const parentId = next.streaming.currentDelegateToolId;
      if (!parentId) return next;
      const parent = next.streaming.toolCalls.get(parentId);
      if (!parent) return next;
      const status: SubagentInfo["status"] =
        env.type === "subagent.start" ? "running" : info.status;
      const existing = parent.subagents ?? [];
      const idx = existing.findIndex((s) => s.subagentId === info.subagentId);
      const merged: SubagentInfo = idx >= 0 ? { ...existing[idx], ...info, status } : { ...info, status };
      const nextSubs =
        idx >= 0
          ? existing.map((s, i) => (i === idx ? merged : s))
          : [...existing, merged];
      const tc = new Map(next.streaming.toolCalls);
      tc.set(parentId, { ...parent, subagents: nextSubs });
      next.streaming = { ...next.streaming, toolCalls: tc };
      return next;
    }
    case "session.info":
    case "background.complete":
    case "subagent.tool":
      return next;
    default:
      return next;
  }
}

// ─── RAF delta-coalescing buffer ─────────────────────────────────────────────
// High-frequency message.delta / reasoning.delta events (100+ per second
// during streaming) each trigger a Zustand set → synchronous re-render. We
// accumulate them in a per-session buffer and flush at most once per animation
// frame, dramatically reducing render throughput during streaming turns.

interface PendingDelta {
  messageDelta: string;
  reasoningDelta: string;
  timer: ReturnType<typeof requestAnimationFrame> | null;
}

const pendingBySession = new Map<string, PendingDelta>();

type ChatStoreSet = StoreApi<ChatStore>["setState"];

function flushPending(sessionId: string, set: ChatStoreSet) {
  const p = pendingBySession.get(sessionId);
  if (!p) return;
  pendingBySession.delete(sessionId);
  if (p.timer !== null) cancelAnimationFrame(p.timer);
  // Build a single Zustand mutation that applies the accumulated text in two
  // synthetic envelopes — messageDelta first, then reasoningDelta.
  // id: 0 intentionally skips the lastEventId bump (guard is id > 0).
  set((store) => {
    let session = store.byId[sessionId];
    if (!session) return store;
    if (p.messageDelta.length > 0) {
      session = reduce(session, {
        id: 0,
        sessionId,
        type: "message.delta",
        payload: { text: p.messageDelta },
        createdAt: new Date().toISOString(),
      });
    }
    if (p.reasoningDelta.length > 0) {
      session = reduce(session, {
        id: 0,
        sessionId,
        type: "reasoning.delta",
        payload: { text: p.reasoningDelta },
        createdAt: new Date().toISOString(),
      });
    }
    return { byId: { ...store.byId, [sessionId]: session } };
  });
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
    // Cancel any buffered delta so a stale RAF flush doesn't mutate the newly
    // reset session after the cold-load clears it.
    const p = pendingBySession.get(id);
    if (p) {
      if (p.timer !== null) cancelAnimationFrame(p.timer);
      pendingBySession.delete(id);
    }
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

  truncateLastTurn(id) {
    // Discard any buffered delta for this session — the turn it belongs to is
    // being wiped, so the text must not appear in the replacement turn.
    const p = pendingBySession.get(id);
    if (p) {
      if (p.timer !== null) cancelAnimationFrame(p.timer);
      pendingBySession.delete(id);
    }
    set((s) => {
      const cur = s.byId[id];
      if (!cur) return s;
      // Find the LAST user message; everything from there on (the user msg
      // itself, any tool cards, the assistant message) goes away. Streaming
      // state is also cleared since the turn it described is gone.
      let cutIndex = -1;
      for (let i = cur.messages.length - 1; i >= 0; i--) {
        if (cur.messages[i].kind === "user") {
          cutIndex = i;
          break;
        }
      }
      if (cutIndex < 0) return s;
      const next: ChatSessionState = {
        ...cur,
        messages: cur.messages.slice(0, cutIndex),
        streaming: null,
        isStreaming: false,
      };
      return { byId: { ...s.byId, [id]: next } };
    });
  },

  applyEnvelope(id, env) {
    // Hot path: coalesce message.delta and reasoning.delta into a single
    // Zustand mutation per animation frame to avoid 100+ synchronous
    // re-renders per second during streaming.
    if (env.type === "message.delta" || env.type === "reasoning.delta") {
      const rawPayload = env.payload as Record<string, unknown> | null | undefined;
      const text =
        (rawPayload && typeof rawPayload["text"] === "string"
          ? (rawPayload["text"] as string)
          : undefined) ??
        (rawPayload && typeof rawPayload["delta"] === "string"
          ? (rawPayload["delta"] as string)
          : undefined) ??
        "";
      if (!text) return;
      let p = pendingBySession.get(id);
      if (!p) {
        p = { messageDelta: "", reasoningDelta: "", timer: null };
        pendingBySession.set(id, p);
      }
      if (env.type === "message.delta") p.messageDelta += text;
      else p.reasoningDelta += text;
      if (p.timer === null) {
        p.timer = requestAnimationFrame(() => flushPending(id, set));
      }
      return;
    }
    // For any other event type: flush any accumulated delta first (preserves
    // ordering — text before tool.start, etc.), then apply the event.
    flushPending(id, set);
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
