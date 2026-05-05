/**
 * Chat screen — Stage 6 redesign.
 *
 * Visual target: design/screens-1.jsx::ChatScreen (lines 167-237).
 *
 * Major rebuild of the layout (NavBar with status row, pill composer, sheet
 * menu, new Message renderer) but ALL business logic (useChatStream,
 * chat-store, attachment uploads, history hydration, send-gating) is preserved
 * verbatim from the legacy screen.
 *
 * Coordination with Agent B:
 *   - Tap on a tool card row pushes /chat/[id]/tool/[toolId] (Message owns this)
 *   - Tap on an image attachment thumbnail pushes /chat/[id]/image/[attachmentId]
 *   - Inline ApprovalCard stays here. Push-notification opening of an
 *     approval routes to /chat/[id]/approval/[requestId] which Agent B builds.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  TextInput,
  View,
} from "react-native";
import { MicButton } from "@/voice";
import { useVoiceSettings } from "@/state/voice-settings";
import { FlashList, type FlashListRef, type ListRenderItem } from "@shopify/flash-list";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { setCurrentChatId } from "@/notifications/handler";

import {
  ActionSheet,
  Icon,
  Message as MessageRow,
  NavBar,
  NavIcon,
  PhoneSafeArea,
  Row,
  Sheet,
  SkeletonChat,
  StatusDot,
  Stack,
  Text,
  TodoPlanCard,
  showToast,
  useThemeTokens,
  type ActionSheetHandle,
  type SheetHandle,
  type TodoItem,
  type TodoStatus,
} from "@/components/ui";
import { ApprovalCard } from "@/components/ApprovalCard";
import { ComposerAttachments } from "@/components/ComposerAttachments";
import * as Clipboard from "expo-clipboard";
import { exportChat } from "@/util/export-chat";
import { safeBack } from "@/util/nav";
import { useChatStream } from "@/ws/use-chat-stream";
import { useChatStore } from "@/state/chat-store";
import { useTodosUi } from "@/state/todos";
import { usePendingAttachments } from "@/state/pending-attachments";
import { pickDocument, pickImage, PickerError } from "@/attachments/picker";
import {
  archiveSession,
  deleteSession,
  getMessages,
  listSessions,
  reloadSessionMcp,
  renameSession,
} from "@/api/sessions";
import type { AttachmentDTO, HistoryRow, MessagesPage, SessionDto } from "@/api/types";
import type {
  ApprovalRequest,
  AssistantMessage,
  ChatSessionState,
  Message,
  SubagentInfo,
  ToolCallState,
} from "@/state/chat-store";
import type { ConnectionStatus } from "@/ws/client";
import type { StatusDotKind } from "@/components/ui";

// ─── row model (carried over from legacy) ───────────────────────────────────

type Row =
  | { rowKind: "msg"; data: Message }
  | { rowKind: "stream-tool"; data: ToolCallState }
  | { rowKind: "stream-msg"; data: AssistantMessage }
  | { rowKind: "approval"; data: ApprovalRequest };

// Wraps the stream-tool branch of renderItem so the synthesized ToolCallCard
// object is memoized by (id, name, status, detail, createdAt, subagents) — not
// re-created on every renderItem call. Without this wrapper the object literal
// inside renderItem always has a fresh identity, defeating Message's memo.
const StreamToolMessageRow = memo(function StreamToolMessageRow(props: {
  data: ToolCallState;
  sessionId: string | null;
  latestTodoToolId: string | null | undefined;
}) {
  const { data, sessionId, latestTodoToolId } = props;
  const message = useMemo<Message>(
    () => ({
      kind: "tool",
      id: data.id,
      name: data.name,
      status: data.status,
      detail: data.detail,
      createdAt: data.createdAt,
      ...(data.subagents ? { subagents: data.subagents } : {}),
    }),
    [data.id, data.name, data.status, data.detail, data.createdAt, data.subagents],
  );
  return (
    <MessageRow
      message={message}
      sessionId={sessionId}
      latestTodoToolId={latestTodoToolId}
    />
  );
});

function buildRows(state: ChatSessionState | undefined): Row[] {
  if (!state) return [];
  const rows: Row[] = state.messages.map<Row>((m) => ({ rowKind: "msg", data: m }));
  if (state.streaming) {
    for (const tc of state.streaming.toolCalls.values()) {
      rows.push({ rowKind: "stream-tool", data: tc });
    }
    // Show streaming bubble even before any text arrives so user sees activity.
    const streamMsg: AssistantMessage = {
      kind: "assistant",
      id: "__streaming__",
      text: state.streaming.textBuffer,
      reasoning:
        state.streaming.reasoningBuffer.length > 0
          ? state.streaming.reasoningBuffer
          : undefined,
      createdAt: state.streaming.startedAt,
    };
    rows.push({ rowKind: "stream-msg", data: streamMsg });
  }
  for (const a of state.pendingApprovals) {
    rows.push({ rowKind: "approval", data: a });
  }
  return rows;
}

const EMPTY_PENDING: never[] = [];

function pickString(p: Record<string, unknown>, key: string): string {
  const v = p[key];
  return typeof v === "string" ? v : "";
}

// Convert a permanent chat_history row into a UI Row.
//
// `resolvedApproval` flags whether an approval.* row should be rendered as
// resolved (compact pill) vs. still-pending (full ApprovalCard). The chat
// screen passes `true` for any approval row that has *any* row after it in
// history — Hermes can't continue past an open approval, so anything after
// proves the request was answered. Live `pendingApprovals` overlays the
// last-row case and replaces the history version via requestId match.
// True when a chat_history `tool.call` row is actually a subagent.* event
// that the gateway collapsed into kind="tool.call" on persistence. They lack
// a `name` / `tool_id` and carry a `subagent_id` instead.
function isSubagentHistoryRow(r: HistoryRow): boolean {
  if (r.kind !== "tool.call") return false;
  return typeof r.payload["subagent_id"] === "string";
}

function readSubagentFromHistory(r: HistoryRow): SubagentInfo | null {
  const p = r.payload;
  const subagentId = pickString(p, "subagent_id");
  if (!subagentId) return null;
  const goal = pickString(p, "goal");
  const taskIndexRaw = p["task_index"];
  const taskCountRaw = p["task_count"];
  const taskIndex = typeof taskIndexRaw === "number" ? taskIndexRaw : 0;
  const taskCount = typeof taskCountRaw === "number" ? taskCountRaw : 1;
  const statusStr = pickString(p, "status");
  let status: SubagentInfo["status"] = "completed";
  if (statusStr === "interrupted") status = "interrupted";
  else if (statusStr === "error") status = "error";
  const durationRaw = p["duration_seconds"];
  const durationSec = typeof durationRaw === "number" ? durationRaw : undefined;
  const summaryRaw = pickString(p, "summary");
  const summary =
    summaryRaw && summaryRaw !== "(empty)" && summaryRaw.length > 0 ? summaryRaw : undefined;
  const model = pickString(p, "model");
  const toolsetsRaw = p["toolsets"];
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

function historyRowToUiRow(
  r: HistoryRow,
  resolvedApproval: boolean,
  subagentsForThisRow?: SubagentInfo[],
): Row | null {
  const iso = new Date(r.createdAt * 1000).toISOString();
  const p = r.payload;
  switch (r.kind) {
    case "user.message": {
      const text = pickString(p, "text");
      const attachmentIdsRaw = p["attachmentIds"];
      const attachmentRefs = Array.isArray(attachmentIdsRaw)
        ? attachmentIdsRaw.filter((v): v is string => typeof v === "string")
        : undefined;
      if (!text && (!attachmentRefs || attachmentRefs.length === 0)) return null;
      return {
        rowKind: "msg",
        data: {
          kind: "user",
          id: `hist-u-${r.id}`,
          text,
          createdAt: iso,
          ...(attachmentRefs && attachmentRefs.length > 0 ? { attachmentRefs } : {}),
        },
      };
    }
    case "assistant.message": {
      const text = pickString(p, "text");
      const reasoning = pickString(p, "reasoning") || pickString(p, "reasoning_content");
      const warning = pickString(p, "warning");
      const status = pickString(p, "status");
      const interrupted = status === "interrupted";
      if (!text && !reasoning) return null;
      return {
        rowKind: "msg",
        data: {
          kind: "assistant",
          id: `hist-a-${r.id}`,
          text,
          ...(reasoning ? { reasoning } : {}),
          ...(warning ? { warning } : {}),
          ...(interrupted ? { interrupted: true } : {}),
          createdAt: iso,
        },
      };
    }
    case "tool.call": {
      const name = pickString(p, "name") || "tool";
      return {
        rowKind: "msg",
        data: {
          kind: "tool",
          id: `hist-t-${r.id}`,
          name,
          status: "complete",
          detail: p,
          createdAt: iso,
          ...(subagentsForThisRow && subagentsForThisRow.length > 0
            ? { subagents: subagentsForThisRow }
            : {}),
        },
      };
    }
    case "reasoning": {
      const text = pickString(p, "text");
      if (!text) return null;
      return {
        rowKind: "msg",
        data: {
          kind: "assistant",
          id: `hist-r-${r.id}`,
          text: "",
          reasoning: text,
          createdAt: iso,
        },
      };
    }
    case "approval.request":
    case "clarify.request":
    case "sudo.request":
    case "secret.request": {
      const requestId = pickString(p, "request_id") || `hist-${r.id}`;
      const prompt =
        pickString(p, "question") ||
        pickString(p, "prompt") ||
        pickString(p, "command") ||
        r.kind;
      const apiKind: ApprovalRequest["kind"] = r.kind.startsWith("approval")
        ? "approval"
        : r.kind.startsWith("clarify")
          ? "clarify"
          : r.kind.startsWith("sudo")
            ? "sudo"
            : "secret";
      return {
        rowKind: "approval",
        data: {
          kind: apiKind,
          requestId,
          prompt,
          raw: p,
          createdAt: iso,
          resolved: resolvedApproval,
        },
      };
    }
    case "error": {
      const msg = pickString(p, "message") || pickString(p, "error") || "Error";
      return {
        rowKind: "msg",
        data: {
          kind: "error",
          id: `hist-e-${r.id}`,
          message: msg,
          createdAt: iso,
        },
      };
    }
  }
}

function statusToDotKind(s: ConnectionStatus): StatusDotKind {
  switch (s) {
    case "open":
      return "online";
    case "connecting":
    case "reconnecting":
      return "connecting";
    case "auth_required":
    case "sync_required":
    case "closed":
      return "offline";
    case "idle":
      return "idle";
  }
}

function statusLabel(s: ConnectionStatus, retryInMs: number | null): string {
  switch (s) {
    case "open":
      return "online";
    case "connecting":
      return "connecting";
    case "reconnecting":
      return retryInMs ? `retry ${Math.ceil(retryInMs / 1000)}s` : "reconnecting";
    case "auth_required":
      return "auth required";
    case "sync_required":
      return "sync required";
    case "closed":
      return "offline";
    case "idle":
      return "idle";
  }
}

// ─── screen ─────────────────────────────────────────────────────────────────

export default function ChatScreen() {
  const params = useLocalSearchParams<{ id: string; messageId?: string }>();
  const sessionId = typeof params.id === "string" ? params.id : null;
  const router = useRouter();
  // Phase 6 deep-link: numeric chat_history row id from a search-result tap.
  // Parsed once per param change; null when missing or non-finite.
  const targetMessageId = useMemo<number | null>(() => {
    if (typeof params.messageId !== "string" || params.messageId.length === 0) {
      return null;
    }
    const n = Number(params.messageId);
    return Number.isFinite(n) ? n : null;
  }, [params.messageId]);
  const tokens = useThemeTokens();
  const queryClient = useQueryClient();
  const sheetRef = useRef<SheetHandle>(null);

  const flatListRef = useRef<FlashListRef<Row>>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [matchIdx, setMatchIdx] = useState(0);
  const searchInputRef = useRef<TextInput>(null);
  // Phase 6 deep-link: brief accent-tint on the message we navigated to.
  // Distinct from `activeMatchId` (in-chat search). One-shot; cleared after
  // ~1.5s so the row reverts to its default rendering.
  const [flashMessageId, setFlashMessageId] = useState<number | null>(null);

  const sessionState = useChatStore((s) => (sessionId ? s.byId[sessionId] : undefined));
  const latestTodoToolId = useChatStore((s) =>
    sessionId ? (s.latestTodoToolIdById[sessionId] ?? null) : null,
  );
  const setLatestTodoToolId = useChatStore((s) => s.setLatestTodoToolId);
  const stream = useChatStream(sessionId);
  const [input, setInput] = useState("");
  const inputRef = useRef<TextInput>(null);

  // ─── voice input ─────────────────────────────────────────────────────────
  const voiceEnabled = useVoiceSettings((s) => s.enabled);
  const voiceMode = useVoiceSettings((s) => s.mode);
  const voiceLanguage = useVoiceSettings((s) => s.language);
  const voiceAddsPunctuation = useVoiceSettings((s) => s.addsPunctuation);
  // Partial transcript from MicButton's live preview (D2). Cleared when the
  // final transcript fires and is promoted into `input`.
  const [partialVoice, setPartialVoice] = useState("");
  const pendingList = usePendingAttachments(
    (s) => (sessionId ? (s.bySession[sessionId] ?? EMPTY_PENDING) : EMPTY_PENDING),
  );
  const addPending = usePendingAttachments((s) => s.add);
  const clearPending = usePendingAttachments((s) => s.clearSession);

  // Session metadata (title/archive). We pull it from the cached sessions
  // list so navigating from the list shows the correct title immediately.
  const sessionsQuery = useQuery({
    queryKey: ["sessions"] as const,
    queryFn: listSessions,
  });
  const session: SessionDto | undefined = useMemo(
    () => sessionsQuery.data?.sessions.find((s) => s.id === sessionId),
    [sessionsQuery.data, sessionId],
  );

  // Cold-load history (paginated). "Next page" semantically = "older history",
  // keyed off the earliest loaded id. Newer content arrives via the WS stream
  // (chat-store), not via fetchPreviousPage — so there's no
  // getPreviousPageParam.
  type MessagesPageParam = { before?: number; around?: number } | undefined;

  const messagesQuery = useInfiniteQuery<
    MessagesPage,
    Error,
    { pages: MessagesPage[]; pageParams: MessagesPageParam[] },
    readonly ["session-messages", string | null],
    MessagesPageParam
  >({
    queryKey: ["session-messages", sessionId] as const,
    enabled: !!sessionId,
    initialPageParam: undefined,
    queryFn: ({ pageParam }) => {
      if (!sessionId) {
        return Promise.resolve({ rows: [], hasBefore: false, hasAfter: false });
      }
      return getMessages(sessionId, { ...pageParam, limit: 50 });
    },
    getNextPageParam: (last) =>
      last.hasBefore && last.rows[0]
        ? { before: last.rows[0].id }
        : undefined,
    staleTime: 30_000,
    gcTime: 60_000,
  });

  // Flatten paginated history into a single ascending-by-id list. Each
  // additional page is prepended (older first) by the gateway, so flatMap
  // preserves "oldest → newest" order across the full loaded window.
  const apiRows = useMemo<HistoryRow[]>(
    () => messagesQuery.data?.pages.flatMap((p) => p.rows) ?? [],
    [messagesQuery.data],
  );

  // Scroll-up handler — wired to FlashList's onStartReached. Guards on both
  // hasNextPage and the in-flight flags so rapid scroll bounces don't fire
  // duplicate fetches (TanStack also dedupes, but the guard avoids the
  // overhead of even calling fetchNextPage during an active fetch).
  const handleStartReached = useCallback(() => {
    if (
      messagesQuery.hasNextPage &&
      !messagesQuery.isFetchingNextPage &&
      !messagesQuery.isFetching
    ) {
      void messagesQuery.fetchNextPage();
    }
  }, [
    messagesQuery.hasNextPage,
    messagesQuery.isFetchingNextPage,
    messagesQuery.isFetching,
    messagesQuery.fetchNextPage,
  ]);

  // Cold-load: walk history backward, find the most recent tool.call with
  // name="todo" and seed latestTodoToolIdById so the right card gets the
  // footer treatment on first render. Live tool.complete envelopes update
  // the same field via the chat-store reducer.
  useEffect(() => {
    if (!sessionId) return;
    if (apiRows.length === 0) return;
    for (let i = apiRows.length - 1; i >= 0; i--) {
      const r = apiRows[i];
      if (r.kind !== "tool.call") continue;
      const p = r.payload;
      if (p?.["name"] !== "todo") continue;
      if (!Array.isArray(p?.["todos"])) continue;
      const tid = p["tool_id"];
      if (typeof tid === "string") {
        setLatestTodoToolId(sessionId, tid);
      }
      return;
    }
  }, [sessionId, apiRows, setLatestTodoToolId]);

  // ─── foreground push suppression ────────────────────────────────────────
  // Tell the notification handler which chat is currently on screen so it
  // can skip the banner for pushes that belong to this exact session.
  useFocusEffect(
    useCallback(() => {
      if (sessionId) setCurrentChatId(sessionId);
      return () => setCurrentChatId(null);
    }, [sessionId]),
  );

  // ─── pinned card lookup ──────────────────────────────────────────────────
  const todosPinnedMap = useTodosUi((s) => s.pinnedByCard);
  const pinnedToolId = useMemo<string | null>(() => {
    if (!sessionId) return null;
    const prefix = `${sessionId}:`;
    for (const [k, v] of Object.entries(todosPinnedMap)) {
      if (!v) continue;
      if (!k.startsWith(prefix)) continue;
      return k.slice(prefix.length);
    }
    return null;
  }, [sessionId, todosPinnedMap]);

  const historyRows = useMemo<Row[]>(() => {
    if (!apiRows.length) return [];
    const out: Row[] = [];
    // Reasoning placement (option B): a `reasoning` row folds into the bubble
    // of the *immediately next* `assistant.message` (becomes its
    // collapsible "Show reasoning"). Otherwise it renders inline at its own
    // position — so mid-turn thinking around tool calls stays visible.
    let pendingReasoning: string | null = null;
    // Subagent buffer: gateway persists `subagent.complete` events as
    // kind="tool.call" rows that come *before* the parent delegate_task
    // row. Collect them here; drain into the next delegate_task row so the
    // UI gets one grouped card per delegation.
    let pendingSubagents: SubagentInfo[] = [];
    for (let i = 0; i < apiRows.length; i++) {
      const r = apiRows[i];
      if (isSubagentHistoryRow(r)) {
        const info = readSubagentFromHistory(r);
        if (info) pendingSubagents.push(info);
        continue;
      }
      if (r.kind === "reasoning") {
        const text = pickString(r.payload, "text");
        if (!text) continue;
        const next = apiRows[i + 1];
        if (next && next.kind === "assistant.message") {
          // Defer — attach to the next assistant.message.
          pendingReasoning = text;
        } else {
          // Render inline as its own reasoning-only block.
          const ui = historyRowToUiRow(r, false);
          if (ui) out.push(ui);
        }
        continue;
      }
      if (r.kind === "assistant.message") {
        const text = pickString(r.payload, "text");
        const explicitReasoning =
          pickString(r.payload, "reasoning") ||
          pickString(r.payload, "reasoning_content");
        // Prefer reasoning embedded in the payload; else use the pending one.
        // Drop if it duplicates the visible text.
        const merged =
          explicitReasoning ||
          (pendingReasoning && pendingReasoning !== text ? pendingReasoning : "");
        const synthetic: HistoryRow = {
          ...r,
          payload: { ...r.payload, reasoning: merged },
        };
        const ui = historyRowToUiRow(synthetic, false);
        if (ui) out.push(ui);
        pendingReasoning = null;
        continue;
      }
      // Defensive: look-ahead said next was assistant.message but we got
      // something else (shouldn't happen since look-ahead is exact). Flush
      // the pending reasoning inline so we don't lose it.
      if (pendingReasoning) {
        out.push({
          rowKind: "msg",
          data: {
            kind: "assistant",
            id: `hist-r-orphan-${i}`,
            text: "",
            reasoning: pendingReasoning,
            createdAt: new Date(r.createdAt * 1000).toISOString(),
          },
        });
        pendingReasoning = null;
      }
      // Approval rows are resolved iff anything exists after them in history.
      const isLast = i === apiRows.length - 1;
      const resolvedApproval = !isLast;
      // delegate_task is the parent — drain pending subagents into it.
      const isDelegateParent =
        r.kind === "tool.call" && pickString(r.payload, "name") === "delegate_task";
      const subsForRow = isDelegateParent ? pendingSubagents : undefined;
      if (isDelegateParent) pendingSubagents = [];
      const ui = historyRowToUiRow(r, resolvedApproval, subsForRow);
      if (ui) out.push(ui);
    }
    // Tail: a reasoning row at the very end with nothing after it. Surface
    // inline rather than dropping silently.
    if (pendingReasoning) {
      out.push({
        rowKind: "msg",
        data: {
          kind: "assistant",
          id: "hist-r-tail",
          text: "",
          reasoning: pendingReasoning,
          createdAt: new Date().toISOString(),
        },
      });
    }
    return out;
  }, [apiRows]);

  const rows = useMemo<Row[]>(() => {
    const live = buildRows(sessionState);
    // Live `pendingApprovals` is the source of truth for any approval still
    // open. If the same requestId also appears in history, drop the history
    // copy so we don't double-render the card.
    const liveApprovalIds = new Set(
      sessionState?.pendingApprovals.map((a) => a.requestId) ?? [],
    );
    const filteredHistory = historyRows.filter(
      (r) => r.rowKind !== "approval" || !liveApprovalIds.has(r.data.requestId),
    );
    return [...filteredHistory, ...live];
  }, [historyRows, sessionState]);

  // Resolve the pinned card's payload — search live messages first (they hold
  // the latest todos array post-update), fall back to history rows. The
  // tool_id we're matching is the upstream-stable id, persisted in
  // detail.tool_id for tool messages.
  const pinnedTodoData = useMemo<{
    todos: TodoItem[];
    status: "running" | "complete" | "error";
    createdAt: string;
  } | null>(() => {
    if (!pinnedToolId) return null;
    const validate = (raw: unknown): TodoItem[] | null => {
      if (!Array.isArray(raw)) return null;
      const allowed: ReadonlySet<TodoStatus> = new Set([
        "pending",
        "in_progress",
        "completed",
        "cancelled",
      ]);
      const out: TodoItem[] = [];
      for (const v of raw) {
        if (!v || typeof v !== "object") return null;
        const r = v as Record<string, unknown>;
        if (
          typeof r.id !== "string" ||
          typeof r.content !== "string" ||
          typeof r.status !== "string" ||
          !allowed.has(r.status as TodoStatus)
        ) {
          return null;
        }
        out.push({ id: r.id, content: r.content, status: r.status as TodoStatus });
      }
      return out;
    };
    // Live messages — newest entry with matching tool_id wins.
    const msgs = sessionState?.messages ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.kind !== "tool" || m.name !== "todo") continue;
      const detailToolId =
        typeof m.detail?.tool_id === "string" ? (m.detail.tool_id as string) : null;
      const ownId = detailToolId ?? m.id;
      if (ownId !== pinnedToolId) continue;
      const todos = validate(m.detail?.todos);
      if (todos) return { todos, status: m.status, createdAt: m.createdAt };
    }
    // History rows fallback.
    for (let i = apiRows.length - 1; i >= 0; i--) {
      const r = apiRows[i];
      if (r.kind !== "tool.call") continue;
      const p = r.payload;
      if (p?.["name"] !== "todo") continue;
      const tid = typeof p["tool_id"] === "string" ? (p["tool_id"] as string) : null;
      if (tid !== pinnedToolId) continue;
      const todos = validate(p["todos"]);
      if (todos) {
        return {
          todos,
          status: "complete",
          createdAt: new Date(r.createdAt * 1000).toISOString(),
        };
      }
    }
    return null;
  }, [pinnedToolId, sessionState, apiRows]);

  // FlashList v2 with startRenderingFromBottom anchors the END of the data
  // array to the bottom of the viewport, so chronological order (oldest first,
  // newest last) is what we want — no reversal needed.
  const reversed = useMemo(() => rows, [rows]);

  // ─── search-in-chat ──────────────────────────────────────────────────────
  // Match against user/assistant text (case-insensitive substring). Approval,
  // tool, and error rows are ignored — search is for narrative content.
  const trimmedQuery = searchQuery.trim();
  const searchActive = searchOpen && trimmedQuery.length > 0;
  const matchIds = useMemo<string[]>(() => {
    if (!searchActive) return [];
    const q = trimmedQuery.toLowerCase();
    const out: string[] = [];
    for (const r of rows) {
      if (r.rowKind !== "msg") continue;
      const m = r.data;
      if (m.kind === "user") {
        if (m.text.toLowerCase().includes(q)) out.push(m.id);
      } else if (m.kind === "assistant") {
        if (m.text.toLowerCase().includes(q)) out.push(m.id);
        else if (m.reasoning && m.reasoning.toLowerCase().includes(q)) out.push(m.id);
      }
    }
    return out;
  }, [rows, trimmedQuery, searchActive]);
  const matchIdSet = useMemo(() => new Set(matchIds), [matchIds]);
  const totalMatches = matchIds.length;
  const safeMatchIdx = totalMatches === 0 ? 0 : Math.min(matchIdx, totalMatches - 1);
  const activeMatchId = totalMatches > 0 ? matchIds[safeMatchIdx] : null;

  // Reset cursor when query changes.
  useEffect(() => {
    setMatchIdx(0);
  }, [trimmedQuery]);

  // Scroll the FlashList to the active search match.
  useEffect(() => {
    if (!activeMatchId || !flatListRef.current) return;
    const idx = reversed.findIndex(
      (r) => r.rowKind === "msg" && r.data.id === activeMatchId,
    );
    if (idx < 0) return;
    flatListRef.current
      .scrollToIndex({ index: idx, animated: true, viewPosition: 0.5 })
      .catch(() => {
        /* ignore — index may be temporarily out-of-range during re-render */
      });
  }, [activeMatchId, reversed]);

  // Phase 6 deep-link: when the chat is opened with `?messageId=<chat_history.id>`
  // (set by QuickSwitcher), scroll to that message and flash an accent tint.
  // Reuses the same scroll + tint pipeline as the in-chat search path; just a
  // different one-shot trigger. UI message ids are encoded as
  // `hist-{u,a,r,t,e}-<chat_history.id>`, so we match by trailing numeric id
  // rather than the raw `messageId` number.
  //
  // Replay guard: a `consumedRef` records the last messageId we acted on.
  // We can't rely solely on the deps array because the effect itself calls
  // `router.setParams({ messageId: undefined })` to clean the URL — that
  // flips `targetMessageId` to null and re-triggers the effect, which would
  // otherwise tear down our own timers via the cleanup function. Timers are
  // therefore held in refs and only cleared on unmount (separate effect
  // below), not on this effect's deps-change cycle.
  //
  // Limitation: if the target message lies outside the currently loaded
  // history window (long chats, no around-cursor pagination yet) we no-op
  // with an info log. The plan calls out a `?around=<rowId>` endpoint as a
  // ~1h follow-up; deliberately deferred for v1.
  const consumedDeepLinkRef = useRef<number | null>(null);
  const deepLinkScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deepLinkFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (targetMessageId == null) return;
    if (consumedDeepLinkRef.current === targetMessageId) return;
    if (reversed.length === 0) return;
    const suffix = `-${targetMessageId}`;
    const idx = reversed.findIndex((r) => {
      if (r.rowKind !== "msg") return false;
      const id = r.data.id;
      if (typeof id !== "string" || !id.startsWith("hist-")) return false;
      if (!id.endsWith(suffix)) return false;
      // Strict trailing-number guard — `endsWith("-12")` would also match
      // "hist-u-112". Compare the parsed trailing integer instead.
      const dash = id.lastIndexOf("-");
      const tail = id.slice(dash + 1);
      return tail === String(targetMessageId);
    });
    consumedDeepLinkRef.current = targetMessageId;
    if (idx < 0) {
      console.info(
        `[chat] deep-link messageId=${targetMessageId} not found in loaded window (session=${sessionId ?? "?"})`,
      );
      // Still consume the param so back-and-forth navigation doesn't keep
      // re-firing this effect on an unresolvable target.
      router.setParams({ messageId: undefined });
      return;
    }
    if (deepLinkScrollTimerRef.current) clearTimeout(deepLinkScrollTimerRef.current);
    if (deepLinkFlashTimerRef.current) clearTimeout(deepLinkFlashTimerRef.current);
    deepLinkScrollTimerRef.current = setTimeout(() => {
      flatListRef.current
        ?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.5 })
        .catch(() => undefined);
    }, 150);
    setFlashMessageId(targetMessageId);
    deepLinkFlashTimerRef.current = setTimeout(() => setFlashMessageId(null), 1500);
    // Clear the URL param so a re-render / refocus doesn't replay the deep
    // link. expo-router treats a fresh navigation with the same key as a new
    // value (the consumedRef tracks the numeric id), so the next
    // QuickSwitcher tap on the same target still fires the effect.
    router.setParams({ messageId: undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `router` and
    // `sessionId` are stable per mount and intentionally excluded so we
    // don't re-fire on unrelated navigation churn.
  }, [targetMessageId, reversed.length]);
  // Unmount-only cleanup: cancel any in-flight deep-link timers so a quick
  // back-out doesn't fire setState on an unmounted screen. Empty dep array
  // intentional — runs once at unmount.
  useEffect(() => {
    return () => {
      if (deepLinkScrollTimerRef.current) clearTimeout(deepLinkScrollTimerRef.current);
      if (deepLinkFlashTimerRef.current) clearTimeout(deepLinkFlashTimerRef.current);
    };
  }, []);

  const onSearchOpen = useCallback(() => {
    setSearchOpen(true);
    setTimeout(() => searchInputRef.current?.focus(), 50);
  }, []);
  const onSearchClose = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
    setMatchIdx(0);
  }, []);
  const onMatchPrev = useCallback(() => {
    if (totalMatches === 0) return;
    setMatchIdx((i) => (i - 1 + totalMatches) % totalMatches);
  }, [totalMatches]);
  const onMatchNext = useCallback(() => {
    if (totalMatches === 0) return;
    setMatchIdx((i) => (i + 1) % totalMatches);
  }, [totalMatches]);

  // ─── inline assistant actions ───────────────────────────────────────────
  // ChatGPT/Claude pattern: a small icon row below every assistant reply.
  // Copy is universal; Regenerate is only enabled on the latest assistant
  // because it truncates the last turn server-side (chat_history,
  // ws_events, Hermes' in-memory history all align on that).
  const lastAssistantId = useMemo<string | null>(() => {
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (r.rowKind === "msg" && r.data.kind === "assistant") return r.data.id;
    }
    return null;
  }, [rows]);

  const findPairedUserMessage = useCallback(
    (assistantId: string): { text: string; attachments?: AttachmentDTO[] } | null => {
      let assistantIdx = -1;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (r.rowKind === "msg" && r.data.id === assistantId) {
          assistantIdx = i;
          break;
        }
      }
      if (assistantIdx < 0) return null;
      for (let i = assistantIdx - 1; i >= 0; i--) {
        const r = rows[i];
        if (r.rowKind !== "msg" || r.data.kind !== "user") continue;
        return {
          text: r.data.text,
          attachments: r.data.attachments,
        };
      }
      return null;
    },
    [rows],
  );

  const onCopyAssistant = useCallback(
    (text: string) => {
      if (text) void Clipboard.setStringAsync(text);
    },
    [],
  );

  const onRegenerateAssistant = useCallback(
    (assistantId: string) => {
      const paired = findPairedUserMessage(assistantId);
      if (paired) stream.regenerate(paired.text, paired.attachments);
    },
    [findPairedUserMessage, stream],
  );

  // Send-gating: hold sends while uploads are in flight.
  const uploadingCount = pendingList.filter(
    (p) => p.status === "queued" || p.status === "uploading",
  ).length;
  const failedCount = pendingList.filter((p) => p.status === "failed").length;
  const uploadedAttachments = useMemo<AttachmentDTO[]>(() => {
    const out: AttachmentDTO[] = [];
    for (const p of pendingList) {
      if (p.status === "uploaded" && p.attachment) out.push(p.attachment);
    }
    return out;
  }, [pendingList]);

  const isStreaming = sessionState?.isStreaming ?? false;
  const hasUploaded = uploadedAttachments.length > 0;
  const sendDisabled =
    isStreaming ||
    uploadingCount > 0 ||
    (input.trim().length === 0 && !hasUploaded);
  const sendHint =
    uploadingCount > 0
      ? `uploading ${uploadingCount}…`
      : failedCount > 0
        ? `${failedCount} failed`
        : null;

  const onSend = useCallback(() => {
    if (!sessionId) return;
    if (uploadingCount > 0) return;
    const text = input;
    const hasAttachments = uploadedAttachments.length > 0;
    if (!text.trim() && !hasAttachments) return;
    setInput("");
    stream.send(text, hasAttachments ? uploadedAttachments : undefined);
    if (hasAttachments) clearPending(sessionId);
  }, [
    input,
    sessionId,
    stream,
    uploadingCount,
    uploadedAttachments,
    clearPending,
  ]);

  const onAbort = useCallback(() => {
    stream.abort();
  }, [stream]);

  const onPickImage = useCallback(async () => {
    if (!sessionId) return;
    try {
      const inputs = await pickImage();
      if (inputs.length === 0) return;
      addPending(sessionId, inputs);
    } catch (err: unknown) {
      const msg =
        err instanceof PickerError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Failed to pick image";
      Alert.alert("Image picker", msg);
    }
  }, [sessionId, addPending]);

  const onPickDocument = useCallback(async () => {
    if (!sessionId) return;
    try {
      const inputs = await pickDocument();
      if (inputs.length === 0) return;
      addPending(sessionId, inputs);
    } catch (err: unknown) {
      const msg =
        err instanceof PickerError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Failed to pick document";
      Alert.alert("Document picker", msg);
    }
  }, [sessionId, addPending]);

  const onVoiceTranscript = useCallback(
    (t: string) => {
      setPartialVoice("");
      setInput((prev) => (prev.trim() ? `${prev.trim()} ${t}` : t));
    },
    [],
  );

  const actionSheetRef = useRef<ActionSheetHandle>(null);
  const onAttachPress = useCallback(() => {
    if (!sessionId) return;
    actionSheetRef.current?.present({
      title: "Add attachment",
      actions: [
        { id: "photo", label: "Photo Library", icon: "image", onPress: onPickImage },
        { id: "doc", label: "Document", icon: "doc", onPress: onPickDocument },
      ],
    });
  }, [sessionId, onPickImage, onPickDocument]);

  // ─── menu sheet actions ───────────────────────────────────────────────────

  const onRename = useCallback(() => {
    if (!sessionId || !session) return;
    Alert.prompt?.(
      "Rename session",
      "New title",
      (text) => {
        if (text && text.trim()) {
          void renameSession(sessionId, text.trim()).then(() => {
            void queryClient.invalidateQueries({ queryKey: ["sessions"] });
          });
        }
      },
      "plain-text",
      session.title,
    );
  }, [sessionId, session, queryClient]);

  const onArchive = useCallback(() => {
    if (!sessionId || !session) return;
    void archiveSession(sessionId, !session.archived).then(() => {
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    });
  }, [sessionId, session, queryClient]);

  const onDelete = useCallback(() => {
    if (!sessionId) return;
    Alert.alert("Delete session?", "This cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          void deleteSession(sessionId).then(() => {
            void queryClient.invalidateQueries({ queryKey: ["sessions"] });
            safeBack("/(chats)");
          });
        },
      },
    ]);
  }, [sessionId, queryClient, router]);

  const onReloadMcp = useCallback(() => {
    if (!sessionId) return;
    showToast("Reloading MCP…", "info");
    reloadSessionMcp(sessionId)
      .then((res) => {
        // Hermes' /reload-mcp output has two distinct counts:
        //   "🔧 N tool(s) available from M server(s)"   — MCP-layer (loaded)
        //   "✅ Agent updated — K tool(s) available"    — agent-layer (visible)
        // K can be < N when platform_toolsets.<platform> doesn't include
        // the mcp-<server> entries. Surface that discrepancy as a warning
        // toast — silently showing K=0 is misleading when MCP itself is fine.
        const text = res.output || "";
        const mcpMatch = text.match(/🔧\s+(\d+)\s+tool/);
        const agentMatch = text.match(/Agent updated\s*—\s*(\d+)/);
        const failMatch = text.match(/❌\s*(.+)/);
        if (failMatch) {
          showToast(failMatch[1]?.slice(0, 120) ?? "MCP reload failed", "error");
          return;
        }
        const mcpCount = mcpMatch ? parseInt(mcpMatch[1] ?? "0", 10) : 0;
        const agentCount = agentMatch ? parseInt(agentMatch[1] ?? "0", 10) : 0;
        if (mcpCount === 0) {
          showToast("No MCP servers connected", "warning");
        } else if (agentCount === 0) {
          showToast(
            `MCP loaded ${mcpCount} tools but agent has 0 — check platform_toolsets`,
            "warning",
          );
        } else if (agentCount < mcpCount) {
          showToast(
            `${agentCount}/${mcpCount} MCP tools available to agent`,
            "warning",
          );
        } else {
          showToast(`✅ ${agentCount} MCP tool(s) available`, "success");
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : "Reload failed";
        showToast(msg, "error");
      });
  }, [sessionId]);

  const openSheet = useCallback(() => {
    sheetRef.current?.present();
  }, []);

  const dismissSheet = useCallback(() => {
    sheetRef.current?.dismiss();
  }, []);

  const onExport = useCallback(() => {
    if (!sessionId || !session) return;
    if (apiRows.length === 0) {
      Alert.alert("Nothing to export", "This chat has no messages yet.");
      return;
    }
    const run = (format: "markdown" | "json") => {
      void exportChat(session, apiRows, format).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : "Export failed";
        Alert.alert("Export failed", msg);
      });
    };
    actionSheetRef.current?.present({
      title: "Export chat",
      subtitle: session.title,
      actions: [
        { id: "md", label: "Markdown", icon: "doc", onPress: () => run("markdown") },
        { id: "json", label: "JSON", icon: "doc", onPress: () => run("json") },
      ],
    });
  }, [sessionId, session, apiRows]);

  // ─── render ───────────────────────────────────────────────────────────────

  const renderItem = useCallback<ListRenderItem<Row>>(
    ({ item }) => {
      if (item.rowKind === "msg") {
        const isMatch = matchIdSet.has(item.data.id);
        const m = item.data;
        const isAssistant = m.kind === "assistant";
        const isLastAssistant = isAssistant && m.id === lastAssistantId;
        return (
          <MessageRow
            message={m}
            sessionId={sessionId}
            latestTodoToolId={latestTodoToolId}
            searchActive={searchActive}
            isMatch={isMatch}
            isActiveMatch={
              (searchActive && m.id === activeMatchId) ||
              (flashMessageId != null && m.id === `hist-u-${flashMessageId}`) ||
              (flashMessageId != null && m.id === `hist-a-${flashMessageId}`) ||
              (flashMessageId != null && m.id === `hist-r-${flashMessageId}`) ||
              (flashMessageId != null && m.id === `hist-t-${flashMessageId}`) ||
              (flashMessageId != null && m.id === `hist-e-${flashMessageId}`)
            }
            onCopy={
              isAssistant && m.kind === "assistant"
                ? () => onCopyAssistant(m.text)
                : undefined
            }
            onRegenerate={
              isLastAssistant ? () => onRegenerateAssistant(m.id) : undefined
            }
          />
        );
      }
      if (item.rowKind === "stream-tool") {
        return (
          <StreamToolMessageRow
            data={item.data}
            sessionId={sessionId}
            latestTodoToolId={latestTodoToolId}
          />
        );
      }
      if (item.rowKind === "stream-msg") {
        return (
          <MessageRow
            message={item.data}
            sessionId={sessionId}
            streaming
          />
        );
      }
      if (item.rowKind === "approval") {
        return (
          <ApprovalCard
            request={item.data}
            onApproval={(rid, choice, all) => {
              stream.respondApproval(rid, choice, all);
              useChatStore.getState().resolveApproval(sessionId ?? "", rid);
            }}
            onClarify={(rid, text) => {
              stream.respondClarify(rid, text);
              useChatStore.getState().resolveApproval(sessionId ?? "", rid);
            }}
            onSudo={(rid, choice) => {
              stream.respondSudo(rid, choice);
              useChatStore.getState().resolveApproval(sessionId ?? "", rid);
            }}
            onSecret={(rid, value) => {
              stream.respondSecret(rid, value);
              useChatStore.getState().resolveApproval(sessionId ?? "", rid);
            }}
          />
        );
      }
      return null;
    },
    [
      sessionId,
      stream,
      latestTodoToolId,
      searchActive,
      activeMatchId,
      matchIdSet,
      lastAssistantId,
      onCopyAssistant,
      onRegenerateAssistant,
      flashMessageId,
    ],
  );

  const keyExtractor = useCallback((item: Row): string => {
    switch (item.rowKind) {
      case "msg":
        return `m:${item.data.id}`;
      case "stream-tool":
        return `st:${item.data.id}`;
      case "stream-msg":
        return `sm:${item.data.id}`;
      case "approval":
        return `ap:${item.data.requestId}`;
    }
  }, []);

  const headerTitle = session?.title || "New chat";
  // Banner visibility:
  //   - Before the first non-idle status arrives (cold mount), stay hidden
  //     so we don't flash a meaningless "idle" pill.
  //   - From the moment the WS has actually reported any state, the banner
  //     stays visible whenever status !== "open". Sticky on every non-OK
  //     condition (auth_required, reconnecting, closed, sync_required) so
  //     transient flips don't make it vanish.
  //   - 3s grace post-reconnect for an "Online" confirmation.
  const [showOnlineConfirmation, setShowOnlineConfirmation] = useState(false);
  const hasConnectedOnce = useRef(false);
  const wasNonOpen = useRef(false);
  useEffect(() => {
    if (stream.status !== "idle") hasConnectedOnce.current = true;
    const isOpen = stream.status === "open";
    if (!isOpen && stream.status !== "idle") {
      wasNonOpen.current = true;
    }
    if (isOpen && wasNonOpen.current) {
      wasNonOpen.current = false;
      setShowOnlineConfirmation(true);
      const t = setTimeout(() => setShowOnlineConfirmation(false), 3000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [stream.status]);
  const showStatusBanner =
    (hasConnectedOnce.current && stream.status !== "open") ||
    showOnlineConfirmation;

  return (
    <PhoneSafeArea>
      <NavBar
        title={headerTitle}
        onBack={() => safeBack("/(chats)")}
        leading={
          // Connection status moved to the dedicated banner below the
          // NavBar — keeping it here too was redundant and crowded the
          // title. Only the per-chat model-override pill remains in the
          // leading slot, and only when an override is actually active.
          session?.modelOverride ? (
            <Row gap={6} align="center" style={{ marginLeft: 4 }}>
              <View
                className="bg-accent-bg"
                style={{
                  paddingHorizontal: 6,
                  paddingVertical: 2,
                  borderRadius: 4,
                }}
              >
                <Text
                  kind="micro"
                  mono
                  color={tokens.accent}
                  numberOfLines={1}
                  style={{ maxWidth: 90 }}
                >
                  {session.modelOverride}
                </Text>
              </View>
            </Row>
          ) : null
        }
        trailing={
          <>
            <NavIcon name="search" onPress={onSearchOpen} />
            <NavIcon name="more" onPress={openSheet} />
          </>
        }
      />

      {searchOpen ? (
        <View
          style={{
            paddingHorizontal: 12,
            paddingVertical: 8,
            backgroundColor: tokens.surface,
            borderBottomWidth: 1,
            borderBottomColor: tokens.line,
          }}
        >
          <Row gap={8} align="center">
            <Icon name="search" size={16} color={tokens.ink3} />
            <TextInput
              ref={searchInputRef}
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Search this chat"
              placeholderTextColor={tokens.ink3}
              returnKeyType="search"
              autoCapitalize="none"
              autoCorrect={false}
              style={{
                flex: 1,
                color: tokens.ink,
                fontFamily: "Inter_400Regular",
                fontSize: 14,
                paddingVertical: 4,
              }}
            />
            {trimmedQuery.length > 0 ? (
              <Text kind="caption" mono color={tokens.ink3}>
                {totalMatches === 0 ? "0/0" : `${safeMatchIdx + 1}/${totalMatches}`}
              </Text>
            ) : null}
            <Pressable
              onPress={onMatchPrev}
              disabled={totalMatches === 0}
              hitSlop={6}
              style={{
                width: 28,
                height: 28,
                alignItems: "center",
                justifyContent: "center",
                opacity: totalMatches === 0 ? 0.3 : 1,
              }}
            >
              <Icon name="chevU" size={16} color={tokens.ink2} />
            </Pressable>
            <Pressable
              onPress={onMatchNext}
              disabled={totalMatches === 0}
              hitSlop={6}
              style={{
                width: 28,
                height: 28,
                alignItems: "center",
                justifyContent: "center",
                opacity: totalMatches === 0 ? 0.3 : 1,
              }}
            >
              <Icon name="chevD" size={16} color={tokens.ink2} />
            </Pressable>
            <Pressable
              onPress={onSearchClose}
              hitSlop={6}
              style={{
                width: 28,
                height: 28,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon name="close" size={16} color={tokens.ink2} />
            </Pressable>
          </Row>
        </View>
      ) : null}

      {showStatusBanner ? (
        <View
          style={{
            paddingHorizontal: 12,
            paddingVertical: 6,
            backgroundColor: tokens.sunken,
            borderBottomWidth: 1,
            borderBottomColor: tokens.lineSoft,
          }}
        >
          <Row gap={8} align="center">
            <StatusDot kind={statusToDotKind(stream.status)} />
            <Text kind="caption" color={tokens.ink2} style={{ flex: 1 }}>
              {statusLabel(stream.status, stream.retryInMs)}
            </Text>
            {stream.status === "sync_required" ? (
              <Pressable
                onPress={stream.acknowledgeSyncRequired}
                style={{
                  paddingHorizontal: 10,
                  paddingVertical: 4,
                  borderRadius: 8,
                  backgroundColor: tokens.ink,
                }}
              >
                <Text kind="caption" color={tokens.surface}>
                  Reload
                </Text>
              </Pressable>
            ) : null}
          </Row>
        </View>
      ) : null}

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        // RN computes bottom padding as `keyboardOverlap + offset`, so a
        // larger offset *increases* the gap between the composer and the
        // keyboard. The composer already sits at the very bottom of the
        // KAV (PhoneSafeArea handles the home-indicator inset above it),
        // so we want zero extra padding — let the keyboard's top edge
        // align flush with the composer's bottom.
        keyboardVerticalOffset={0}
        style={{ flex: 1 }}
      >
        {/* On a cold open we'd otherwise show a blank list flash before
            history hydrates — replace with skeleton bubbles that mirror the
            real Message row rhythm. `isPending` is true only on the very
            first fetch (before any page lands); subsequent paginated fetches
            set `isFetchingNextPage` instead, so the skeleton no longer
            re-shows when scrolling up. */}
        {messagesQuery.isPending && reversed.length === 0 ? (
          <View style={{ flex: 1 }}>
            <SkeletonChat count={5} />
          </View>
        ) : (
          <FlashList
            ref={flatListRef}
            data={reversed}
            keyExtractor={keyExtractor}
            renderItem={renderItem}
            getItemType={(item) => item.rowKind}
            maintainVisibleContentPosition={{
              startRenderingFromBottom: true,
              autoscrollToBottomThreshold: 0.2,
            }}
            onStartReached={handleStartReached}
            onStartReachedThreshold={0.3}
            ListHeaderComponent={
              messagesQuery.isFetchingNextPage ? (
                <View style={{ paddingVertical: 12, alignItems: "center" }}>
                  <ActivityIndicator size="small" color={tokens.ink3} />
                </View>
              ) : null
            }
            contentContainerStyle={{ paddingVertical: 12 }}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            style={{ flex: 1 }}
          />
        )}

        {/* Pinned plan card sits between the message list and the composer
            (above the keyboard) so the active plan is always visible
            without scrolling. */}
        {pinnedToolId && pinnedTodoData && sessionId ? (
          <View
            style={{
              paddingTop: 4,
              paddingBottom: 4,
              backgroundColor: tokens.bg,
              borderTopWidth: 1,
              borderTopColor: tokens.lineSoft,
              shadowColor: "#000",
              shadowOpacity: 0.08,
              shadowRadius: 6,
              shadowOffset: { width: 0, height: -2 },
              elevation: 4,
              zIndex: 10,
            }}
          >
            <TodoPlanCard
              toolCallId={pinnedToolId}
              sessionId={sessionId}
              todos={pinnedTodoData.todos}
              status={pinnedTodoData.status}
              isLatest={latestTodoToolId === pinnedToolId}
              createdAt={pinnedTodoData.createdAt}
            />
          </View>
        ) : null}

        {sessionId ? <ComposerAttachments appSessionId={sessionId} /> : null}
        {sendHint ? (
          <View style={{ paddingHorizontal: 16, paddingTop: 4 }}>
            <Text kind="caption" color={tokens.ink3}>
              {sendHint}
            </Text>
          </View>
        ) : null}

        {/* Live partial-transcript preview (D2). Shown below the composer pill
            while recording; hidden as soon as recording stops. Uses a separate
            line (Approach B) rather than injecting into the TextInput value so
            the cursor position and onChangeText flow are not disturbed. */}
        {partialVoice ? (
          <View style={{ paddingHorizontal: 16, paddingTop: 2, paddingBottom: 2 }}>
            <Text
              kind="caption"
              color={tokens.ink3}
              style={{ fontStyle: "italic" }}
            >
              {partialVoice}
            </Text>
          </View>
        ) : null}

        {/* Pill composer */}
        <View
          style={{
            paddingHorizontal: 10,
            paddingTop: 8,
            paddingBottom: 10,
            backgroundColor: tokens.bg,
          }}
        >
          <Row
            gap={8}
            align="flex-end"
            className="bg-surface border border-line"
            style={{
              paddingLeft: 6,
              paddingRight: 6,
              paddingVertical: 6,
              borderRadius: 22,
            }}
          >
            <Pressable
              onPress={onAttachPress}
              disabled={!sessionId || isStreaming}
              style={{
                width: 32,
                height: 32,
                borderRadius: 16,
                alignItems: "center",
                justifyContent: "center",
                opacity: !sessionId || isStreaming ? 0.4 : 1,
              }}
            >
              <Icon name="plus" size={18} color={tokens.ink2} />
            </Pressable>
            <TextInput
              ref={inputRef}
              value={input}
              onChangeText={setInput}
              placeholder={isStreaming ? "Streaming…" : "Message Hermes…"}
              placeholderTextColor={tokens.ink3}
              multiline
              editable={!!sessionId}
              style={{
                flex: 1,
                color: tokens.ink,
                fontFamily: "Inter_400Regular",
                fontSize: 15,
                lineHeight: 20,
                paddingTop: 8,
                paddingBottom: 8,
                paddingHorizontal: 4,
                maxHeight: 120,
              }}
            />
            {/* MicButton — left of the send/stop control, right of the TextInput.
                Disabled while the agent is streaming to prevent interleaving (D3). */}
            {voiceEnabled ? (
              <MicButton
                mode={voiceMode}
                language={voiceLanguage ?? undefined}
                addsPunctuation={voiceAddsPunctuation}
                disabled={isStreaming}
                onPartial={setPartialVoice}
                onTranscript={onVoiceTranscript}
                onError={(err) => {
                  // TODO: integrate with project showToast once a suitable
                  // message template is defined. For now, surface
                  // permission_denied via a native Alert so the user has
                  // a clear path to fix it.
                  if (err.kind === "permission_denied") {
                    Alert.alert(
                      "Microphone access needed",
                      "Open Settings to allow Hermes to use the microphone.",
                      [{ text: "OK", style: "default" }],
                    );
                  } else {
                    console.warn("Voice error:", err);
                  }
                }}
                size={32}
              />
            ) : null}
            {isStreaming ? (
              <Pressable
                onPress={onAbort}
                accessibilityLabel="Stop generating"
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 16,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: tokens.danger,
                }}
              >
                <View
                  style={{
                    width: 11,
                    height: 11,
                    borderRadius: 2,
                    backgroundColor: "#FFFFFF",
                  }}
                />
              </Pressable>
            ) : (
              <Pressable
                onPress={onSend}
                disabled={sendDisabled}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 16,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: sendDisabled ? tokens.chip : tokens.ink,
                }}
              >
                <Icon
                  name="send"
                  size={16}
                  color={sendDisabled ? tokens.ink3 : tokens.surface}
                />
              </Pressable>
            )}
          </Row>
        </View>
      </KeyboardAvoidingView>

      {/* Quick-actions menu — standardized to 35%. */}
      <ActionSheet ref={actionSheetRef} />

      <Sheet ref={sheetRef} snapPoints={["50%"]}>
        <Stack gap={2} style={{ paddingVertical: 8 }}>
          <SheetItem
            label="Search in chat"
            onPress={() => {
              dismissSheet();
              onSearchOpen();
            }}
          />
          <SheetItem
            label="Switch model for this chat"
            onPress={() => {
              dismissSheet();
              if (sessionId) {
                router.push({
                  pathname: "/(settings)/model" as never,
                  params: { sessionId },
                } as never);
              }
            }}
          />
          <SheetItem
            label="Reload MCP"
            onPress={() => {
              dismissSheet();
              onReloadMcp();
            }}
          />
          <SheetItem
            label="Export"
            onPress={() => {
              dismissSheet();
              onExport();
            }}
          />
          <SheetItem
            label="Rename"
            onPress={() => {
              dismissSheet();
              onRename();
            }}
          />
          <SheetItem
            label={session?.archived ? "Unarchive" : "Archive"}
            onPress={() => {
              dismissSheet();
              onArchive();
            }}
          />
          <SheetItem
            label="Delete"
            danger
            onPress={() => {
              dismissSheet();
              onDelete();
            }}
          />
        </Stack>
      </Sheet>
    </PhoneSafeArea>
  );
}

// ─── sheet item helper ──────────────────────────────────────────────────────

function SheetItem({
  label,
  danger,
  onPress,
}: {
  label: string;
  danger?: boolean;
  onPress: () => void;
}) {
  const tokens = useThemeTokens();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        paddingHorizontal: 20,
        paddingVertical: 14,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Text
        kind="body-lg"
        color={danger ? tokens.danger : tokens.ink}
      >
        {label}
      </Text>
    </Pressable>
  );
}
