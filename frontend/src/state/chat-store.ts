import { create, type StoreApi } from "zustand";
import type { GatewayEventEnvelope } from "../ws/events";
import type { AttachmentDTO } from "../api/types";
import type { VoiceMemoMessage } from "../api/voice-memo";

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
  // Cross-reference into pending-sends: when the bubble was created from an
  // optimistic local send, this id matches the PendingFrame.id in the
  // pending-sends store. The renderer looks up status (queued/sending/
  // failed) by this id to overlay a StatusDot on the bubble. Undefined for
  // history-loaded rows and any user message that came back from the
  // server's chat_history feed.
  clientId?: string;
  // Voice memo fields — present only when the message carries audio.
  // Text-only messages omit all four. `audioBlobUrl` is the relative path
  // (prefixed with API_URL by the renderer / playback controller).
  audioBlobUrl?: string;
  audioDurationMs?: number;
  transcriptionStatus?: "transcribing" | "completed" | "failed";
  transcriptionError?: string | null;
  /** Waveform data: 80 normalized floats (0..1). Null for old memos or failed extraction. */
  audioPeaks?: number[] | null;
  /**
   * Local file URI (file://...) for memos that have not yet been uploaded.
   * Present only when the message was created optimistically from a local
   * recording (id starts with "local-"). Cleared once the server row's
   * audioBlobUrl is available.
   *
   * The audio player uses this for playback while the upload is in flight,
   * falling back to audioBlobUrl when set.
   */
  localAudioUri?: string;
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
  // True when this turn was cancelled mid-flight via session.interrupt.
  // Drives the "Stopped" pill in the assistant bubble.
  interrupted?: boolean;
  // TTS bridge: when Hermes' text_to_speech tool runs and the gateway
  // relocates the blob, the assistant.message envelope carries these so the
  // bubble can render an inline AudioMessage below the text. All optional —
  // a plain text reply leaves them undefined.
  audioBlobUrl?: string;
  audioDurationMs?: number;
  audioPeaks?: number[] | null;
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
  pushUserMessage: (
    id: string,
    text: string,
    attachments?: AttachmentDTO[],
    // Optional pending-sends frame id. Stored on UserMessage.clientId so the
    // renderer can cross-reference per-bubble send status.
    clientId?: string,
  ) => void;
  /**
   * Optimistically insert a voice memo bubble immediately after upload
   * succeeds, using the real DB id returned by the server. The id is formatted
   * as `hist-u-<dbId>` — the same pattern historyRowToUiRow uses — so the
   * dedup filter in the `rows` useMemo can exclude the server-driven history
   * row when the next paginated refetch arrives.
   *
   * When `localId` is supplied the bubble is inserted with that id immediately
   * (pre-upload, optimistic path). The server response later replaces it via
   * `renameMessage`.
   */
  pushVoiceMemoMessage: (
    sessionId: string,
    msg: VoiceMemoMessage | {
      id: string;
      sessionId: string;
      audioPeaks: number[];
      audioDurationMs: number;
      transcriptionStatus: "transcribing" | "completed" | "failed";
      audioBlobUrl: undefined;
      localAudioUri: string;
      /**
       * Image / file attachments queued in the composer when the user
       * released the mic. Drives the thumbnail grid on the optimistic
       * bubble; same shape Message.tsx UserRow renders for text + image.
       */
      attachmentRefs?: AttachmentDTO[];
    },
  ) => void;
  /**
   * Rename a message in-place: move the entry from `oldId` to `newId` without
   * removing and re-inserting (which would cause a FlatList unmount/remount).
   *
   * Used after a successful upload to swap the optimistic "local-<uuid>" id
   * with the server-issued "hist-u-<dbId>" id.
   */
  renameMessage: (sessionId: string, oldId: string, newId: string) => void;
  // Remove a user bubble by its pending-sends clientId. Used when the user
  // chooses "Delete" on a failed offline send — the optimistic bubble must
  // disappear alongside the queued frame.
  removeUserMessage: (sessionId: string, clientId: string) => void;
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
      // Card id mirrors the chat_history row when historyId is on the
      // payload — `hist-t-${id}` matches what historyRowToUiRow produces, so
      // the dedup filter drops the history copy on next session-messages
      // refetch. Falls back to the upstream tool_id for older gateways.
      const historyIdRaw = payload && (payload["historyId"] as unknown);
      const historyId = typeof historyIdRaw === "number" ? historyIdRaw : null;
      const cardId = historyId !== null ? `hist-t-${historyId}` : id;
      const card: ToolCallCard = {
        kind: "tool",
        id: cardId,
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
      const status = getString(payload, "status");
      const isInterrupted = status === "interrupted";
      // Prefer the streamed buffer on interrupt — Hermes' fallback `text`
      // is a boilerplate "Operation interrupted: ..." string that would
      // overwrite the partial output the user just watched stream in.
      const payloadText = getString(payload, "text");
      const bufferText = next.streaming?.textBuffer ?? "";
      const text =
        isInterrupted && bufferText.length > 0
          ? bufferText
          : payloadText ?? bufferText;
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
      // TTS bridge: gateway injects audio_* keys on the message.complete
      // payload when Hermes' text_to_speech tool produced a blob this turn.
      // Pass them straight through to the bubble for AudioMessage rendering.
      const audioBlobUrl = getString(payload, "audio_blob_url");
      const audioDurationMsRaw = (payload as Record<string, unknown>)["audio_duration_ms"];
      const audioDurationMs =
        typeof audioDurationMsRaw === "number" ? audioDurationMsRaw : undefined;
      const audioPeaksRaw = (payload as Record<string, unknown>)["audio_peaks"];
      const audioPeaks = Array.isArray(audioPeaksRaw)
        ? (audioPeaksRaw.filter((v): v is number => typeof v === "number") as number[])
        : undefined;
      // Prefer the chat_history row id (`hist-a-${historyId}`) so this live
      // message dedups against the eventual chat_history row when a
      // session-messages refetch lands. Falls back to `assistant-${envId}`
      // for older gateways that don't stamp historyId yet.
      const historyIdRaw = payload && (payload["historyId"] as unknown);
      const historyId = typeof historyIdRaw === "number" ? historyIdRaw : null;
      const msgId =
        historyId !== null
          ? `hist-a-${historyId}`
          : `assistant-${env.id > 0 ? env.id : genId("a")}`;
      const msg: AssistantMessage = {
        kind: "assistant",
        id: msgId,
        text,
        reasoning: reasoning && reasoning.length > 0 ? reasoning : undefined,
        warning,
        createdAt: env.createdAt,
        ...(reasoningDurationMs !== undefined ? { reasoningDurationMs } : {}),
        ...(isInterrupted ? { interrupted: true } : {}),
        ...(audioBlobUrl ? { audioBlobUrl } : {}),
        ...(audioDurationMs !== undefined ? { audioDurationMs } : {}),
        ...(audioPeaks ? { audioPeaks } : {}),
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
    case "gateway.user.message": {
      // Backend now stamps `historyId` (chat_history row id) onto this
      // envelope's payload. Rewrite the matching live UserMessage's id from
      // its random `genId("u")` to `hist-u-${historyId}`, which is exactly
      // what historyRowToUiRow produces for the same row. Aligning the ids
      // lets the dedup filter in chat/[id].tsx drop the history copy when
      // a session-messages refetch lands during an active turn.
      //
      // We match on clientId — already on both the live UserMessage (set by
      // pushUserMessage) and on this envelope's payload (set by the gateway
      // when persisting the user turn).
      const cid = getString(payload, "clientId");
      const hidRaw = payload && (payload["historyId"] as unknown);
      const hid = typeof hidRaw === "number" ? hidRaw : null;
      if (!cid || hid === null) return next;
      const targetId = `hist-u-${hid}`;
      const idx = next.messages.findIndex(
        (m) => m.kind === "user" && (m as UserMessage).clientId === cid,
      );
      if (idx === -1) return next;
      const cur = next.messages[idx] as UserMessage;
      if (cur.id === targetId) return next;
      const renamed: UserMessage = { ...cur, id: targetId };
      next.messages = next.messages.map((m, i) => (i === idx ? renamed : m));
      return next;
    }
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

  pushUserMessage(id, text, attachments, clientId) {
    set((s) => {
      const cur = s.byId[id] ?? empty(id);
      const msg: UserMessage = {
        kind: "user",
        id: genId("u"),
        text,
        createdAt: new Date().toISOString(),
        attachments: attachments && attachments.length > 0 ? attachments : undefined,
        ...(clientId ? { clientId } : {}),
      };
      return {
        byId: {
          ...s.byId,
          [id]: { ...cur, messages: [...cur.messages, msg] },
        },
      };
    });
  },

  pushVoiceMemoMessage(sessionId, msg) {
    set((s) => {
      const cur = s.byId[sessionId] ?? empty(sessionId);

      // Optimistic local-only path: the caller supplies a local-<uuid> id,
      // no server response yet. audioBlobUrl is undefined; localAudioUri holds
      // the on-disk file that the audio player can already play.
      if ("localAudioUri" in msg) {
        const userMsg: UserMessage = {
          kind: "user",
          id: msg.id,
          text: "",
          createdAt: new Date().toISOString(),
          audioDurationMs: msg.audioDurationMs,
          transcriptionStatus: msg.transcriptionStatus,
          audioPeaks: msg.audioPeaks,
          localAudioUri: msg.localAudioUri,
          // Caller hands us full DTOs; UserMessage.attachments holds those
          // directly (UserMessage.attachmentRefs is the id-only history
          // shape). Keeping the DTOs in-memory means the bubble renders
          // thumbnails without a network round-trip.
          ...(msg.attachmentRefs && msg.attachmentRefs.length > 0
            ? { attachments: msg.attachmentRefs }
            : {}),
        };
        return {
          byId: {
            ...s.byId,
            [sessionId]: { ...cur, messages: [...cur.messages, userMsg] },
          },
        };
      }

      // Server-response path (original): use the real DB id.
      const userMsg: UserMessage = {
        kind: "user",
        id: `hist-u-${msg.id}`,
        text: msg.content,
        createdAt: new Date(msg.createdAt * 1000).toISOString(),
        audioBlobUrl: msg.audioBlobUrl,
        audioDurationMs: msg.audioDurationMs,
        transcriptionStatus: msg.transcriptionStatus,
        ...(msg.transcriptionError ? { transcriptionError: msg.transcriptionError } : {}),
        ...(msg.audioPeaks != null ? { audioPeaks: msg.audioPeaks } : {}),
      };
      return {
        byId: {
          ...s.byId,
          [sessionId]: { ...cur, messages: [...cur.messages, userMsg] },
        },
      };
    });
  },

  renameMessage(sessionId, oldId, newId) {
    set((s) => {
      const cur = s.byId[sessionId];
      if (!cur) return s;
      const idx = cur.messages.findIndex((m) => m.id === oldId);
      if (idx === -1) return s;
      // Mutate the entry in-place within a new array so the FlatList row
      // keeps its React key stable (the key is derived from the object
      // reference via the messages array index, not the id field directly).
      const msgs = cur.messages.slice();
      const existing = msgs[idx];
      if (!existing) return s;
      msgs[idx] = { ...existing, id: newId };
      return {
        byId: {
          ...s.byId,
          [sessionId]: { ...cur, messages: msgs },
        },
      };
    });
  },

  removeUserMessage(sessionId, clientId) {
    set((s) => {
      const cur = s.byId[sessionId];
      if (!cur) return s;
      // Match by clientId — id is a chat-store-internal counter, clientId is
      // the pending-sends-side stable handle. Defensive: if the bubble has
      // already been replaced (e.g. server echoed a real user.message),
      // there's nothing to do.
      const next = cur.messages.filter(
        (m) => !(m.kind === "user" && m.clientId === clientId),
      );
      if (next.length === cur.messages.length) return s;
      return {
        byId: { ...s.byId, [sessionId]: { ...cur, messages: next } },
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
