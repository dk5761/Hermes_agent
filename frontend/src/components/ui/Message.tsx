/**
 * Message — chat row renderer for all message variants.
 *
 * Visual target: design/screens-1.jsx::Message (lines 239-318).
 *
 * Variants:
 *   user       → right-aligned bubble (bg-ink / text-surface)
 *   assistant  → left-aligned, no bubble, Markdown body + optional reasoning
 *   reasoning  → sunken card with mono caption text
 *   tool       → surface card with tool-icon tile, name, args, status dot
 *                (tap navigates to tool detail screen owned by Agent B)
 *   error      → danger-tinted bubble
 *
 * Approval/clarify/sudo/secret rows still render via the legacy ApprovalCard
 * (ported in a later stage); those rows are rendered by the chat screen
 * directly because they don't share the Message union shape.
 */
import React, { memo, useState } from "react";
import { Pressable, View } from "react-native";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";

import type {
  AssistantMessage,
  ErrorBubble,
  Message as ChatMessage,
  ToolCallCard,
  ToolCallState,
  UserMessage,
} from "@/state/chat-store";
import type { AttachmentDTO } from "@/api/types";
import { useAttachmentsByIds } from "@/hooks/useAttachments";
import { AttachmentThumbnail } from "@/components/AttachmentThumbnail";
import { PdfAttachmentRow } from "@/components/PdfAttachmentRow";

import { Icon, type IconName } from "./Icon";
import { MarkdownView } from "./Markdown";
import { Row } from "./Row";
import { Stack } from "./Stack";
import { Text } from "./Text";
import { TodoPlanCard } from "./TodoPlanCard";
import type { TodoItem, TodoStatus } from "./TodoStepRow";
import { useThemeTokens } from "./tokens";

const TODO_STATUSES: ReadonlySet<TodoStatus> = new Set([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);

// Type guard at the trust boundary — `message.detail` is `Record<string, unknown>`.
function isTodoItem(v: unknown): v is TodoItem {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.content === "string" &&
    typeof r.status === "string" &&
    TODO_STATUSES.has(r.status as TodoStatus)
  );
}

function asTodoItems(v: unknown): TodoItem[] | null {
  if (!Array.isArray(v)) return null;
  if (!v.every(isTodoItem)) return null;
  return v as TodoItem[];
}

// Map common tool names to icon glyphs. Default fallback is `bolt`.
const TOOL_ICON: Record<string, IconName> = {
  read_file: "doc",
  read: "doc",
  write_file: "doc",
  write: "doc",
  edit: "edit",
  edit_file: "edit",
  search: "search",
  grep: "search",
  bash: "terminal",
  shell: "terminal",
  exec: "terminal",
  web_fetch: "globe",
  fetch: "globe",
  http: "globe",
  list_dir: "doc",
  ls: "doc",
};

function iconForTool(name: string): IconName {
  return TOOL_ICON[name] ?? "bolt";
}

// Pull a string off an unknown record (used for tool call detail bag).
function pickStr(o: Record<string, unknown> | null | undefined, key: string): string | undefined {
  if (!o) return undefined;
  const v = o[key];
  return typeof v === "string" ? v : undefined;
}

function pickNum(o: Record<string, unknown> | null | undefined, key: string): number | undefined {
  if (!o) return undefined;
  const v = o[key];
  return typeof v === "number" ? v : undefined;
}

// Format a duration (ms) compactly for the tool-card right slot.
function fmtDuration(ms?: number): string | undefined {
  if (ms === undefined || ms < 0) return undefined;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

// ─── attachments ────────────────────────────────────────────────────────────

function AttachmentList({ items }: { items: ReadonlyArray<AttachmentDTO> }) {
  const images = items.filter((a) => a.kind === "image");
  const pdfs = items.filter((a) => a.kind === "pdf" || a.kind === "file");
  const router = useRouter();
  return (
    <Stack gap={6} style={{ marginBottom: items.length > 0 ? 6 : 0 }}>
      {images.length > 0 ? (
        <Row gap={6} style={{ flexWrap: "wrap" }}>
          {images.map((a) => (
            <Pressable
              key={a.id}
              onPress={() => {
                router.push({
                  // Image lightbox modal lives at /chat/[id]/image/[attachmentId]
                  // (built by Agent B). We don't know `id` here so the screen
                  // re-derives it from useLocalSearchParams.
                  pathname: "/chat/[id]/image/[attachmentId]" as const,
                  params: { id: "_", attachmentId: a.id },
                });
              }}
            >
              <AttachmentThumbnail
                attachmentId={a.id}
                hasThumb={a.hasThumb}
                size={140}
              />
            </Pressable>
          ))}
        </Row>
      ) : null}
      {pdfs.map((a) => (
        <PdfAttachmentRow key={a.id} attachment={a} />
      ))}
    </Stack>
  );
}

function UserAttachments({
  attachments,
  attachmentRefs,
}: {
  attachments?: ReadonlyArray<AttachmentDTO>;
  attachmentRefs?: ReadonlyArray<string>;
}) {
  // History rows carry only IDs; resolve them via TanStack-cached fetches.
  // Live messages already have the full DTOs, so skip the network in that path.
  const refs = attachments && attachments.length > 0 ? undefined : attachmentRefs;
  const resolved = useAttachmentsByIds(refs);
  const items = attachments && attachments.length > 0 ? attachments : resolved;
  if (items.length === 0) return null;
  return <AttachmentList items={items} />;
}

// ─── user ───────────────────────────────────────────────────────────────────

function UserRow({ message }: { message: UserMessage }) {
  const tokens = useThemeTokens();
  const hasText = message.text.length > 0;
  const hasAttachments =
    (message.attachments && message.attachments.length > 0) ||
    (message.attachmentRefs && message.attachmentRefs.length > 0);
  return (
    <View style={{ paddingHorizontal: 12, paddingVertical: 4, alignItems: "flex-end" }}>
      <View
        style={{
          maxWidth: "78%",
          paddingHorizontal: 14,
          paddingVertical: 10,
          borderRadius: 18,
          backgroundColor: tokens.ink,
        }}
      >
        {hasAttachments ? (
          <UserAttachments
            attachments={message.attachments}
            attachmentRefs={message.attachmentRefs}
          />
        ) : null}
        {hasText ? (
          <Text
            kind="body"
            color={tokens.surface}
            style={{ fontSize: 15, lineHeight: 20 }}
          >
            {message.text}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

// ─── assistant ──────────────────────────────────────────────────────────────

function ReasoningInline({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const tokens = useThemeTokens();
  return (
    <View
      className="bg-sunken border border-line-soft"
      style={{
        marginTop: 8,
        marginHorizontal: 6,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 8,
      }}
    >
      <Pressable onPress={() => setOpen((v) => !v)}>
        <Row gap={6} align="center">
          <Icon name="spark" size={12} color={tokens.ink3} />
          <Text kind="caption" color={tokens.ink3} style={{ fontWeight: "500" }}>
            {open ? "Hide reasoning" : "Show reasoning"}
          </Text>
        </Row>
      </Pressable>
      {open ? (
        <Text
          kind="caption"
          mono
          color={tokens.ink2}
          style={{ marginTop: 6, lineHeight: 17 }}
        >
          {text}
        </Text>
      ) : null}
    </View>
  );
}

function AssistantRow({
  message,
  streaming,
}: {
  message: AssistantMessage;
  streaming?: boolean;
}) {
  const tokens = useThemeTokens();
  const hasText = message.text.length > 0;
  return (
    <View style={{ paddingHorizontal: 8, paddingVertical: 4, maxWidth: "92%" }}>
      {hasText ? (
        <MarkdownView text={message.text} />
      ) : streaming ? (
        <Text kind="body" color={tokens.ink3}>
          ...
        </Text>
      ) : null}
      {message.warning ? (
        <Row
          gap={6}
          align="center"
          style={{
            marginTop: 6,
            paddingHorizontal: 10,
            paddingVertical: 6,
            borderRadius: 8,
            backgroundColor: tokens.sunken,
            borderWidth: 1,
            borderColor: tokens.line,
          }}
        >
          <Icon name="shield" size={12} color={tokens.warning} />
          <Text kind="caption" color={tokens.warning} style={{ flex: 1 }}>
            {message.warning}
          </Text>
        </Row>
      ) : null}
      {message.reasoning && message.reasoning.length > 0 ? (
        <ReasoningInline text={message.reasoning} />
      ) : null}
    </View>
  );
}

// ─── reasoning-only row (history) ───────────────────────────────────────────

function ReasoningOnlyRow({ text }: { text: string }) {
  const tokens = useThemeTokens();
  return (
    <View
      className="bg-sunken border border-line-soft"
      style={{
        marginHorizontal: 12,
        marginVertical: 4,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 8,
      }}
    >
      <Row gap={6} align="center">
        <Icon name="spark" size={12} color={tokens.ink3} />
        <Text kind="caption" color={tokens.ink3} style={{ fontWeight: "500" }}>
          Thinking
        </Text>
      </Row>
      <Text kind="caption" mono color={tokens.ink2} style={{ marginTop: 4, lineHeight: 17 }}>
        {text}
      </Text>
    </View>
  );
}

// ─── tool ───────────────────────────────────────────────────────────────────

interface ToolRowProps {
  data: ToolCallCard | ToolCallState;
  sessionId: string | null;
}

function ToolRow({ data, sessionId }: ToolRowProps) {
  const tokens = useThemeTokens();
  const router = useRouter();

  // The detail bag carries free-form keys depending on the gateway shape.
  // Try a handful of common ones for the args summary.
  const detail = data.detail as Record<string, unknown> | null | undefined;
  const args =
    pickStr(detail, "args") ??
    pickStr(detail, "arg") ??
    pickStr(detail, "input") ??
    pickStr(detail, "command") ??
    pickStr(detail, "path") ??
    pickStr(detail, "query") ??
    undefined;
  const summary =
    pickStr(detail, "summary") ??
    pickStr(detail, "output_preview") ??
    pickStr(detail, "preview") ??
    undefined;
  const durationMs =
    pickNum(detail, "durationMs") ??
    pickNum(detail, "duration_ms") ??
    pickNum(detail, "duration") ??
    undefined;
  const lines = pickNum(detail, "lines");

  const dotColor =
    data.status === "running"
      ? tokens.accent
      : data.status === "error"
        ? tokens.danger
        : tokens.positive;

  const onPress = () => {
    if (!sessionId) return;
    void Haptics.selectionAsync().catch(() => undefined);
    router.push({
      // Tool detail push route owned by Agent B.
      pathname: "/chat/[id]/tool/[toolId]" as const,
      params: { id: sessionId, toolId: data.id },
    });
  };

  const fmtDur = fmtDuration(durationMs);

  return (
    <Pressable
      onPress={onPress}
      className="bg-surface border border-line"
      style={{
        marginHorizontal: 6,
        marginVertical: 4,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
      }}
    >
      <Row gap={8} align="center" justify="space-between">
        <Row gap={8} align="center" style={{ minWidth: 0, flex: 1 }}>
          <View
            style={{
              width: 22,
              height: 22,
              borderRadius: 6,
              backgroundColor: tokens.chip,
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <Icon name={iconForTool(data.name)} size={12} color={tokens.ink} />
          </View>
          <Text kind="label" mono numberOfLines={1} style={{ flexShrink: 0 }}>
            {data.name}
          </Text>
          {args ? (
            <Text
              kind="caption"
              color={tokens.ink3}
              numberOfLines={1}
              style={{ flex: 1, minWidth: 0 }}
            >
              {args}
            </Text>
          ) : null}
        </Row>
        <Row gap={6} align="center" style={{ flexShrink: 0 }}>
          {fmtDur ? (
            <Text kind="caption" mono color={tokens.ink3}>
              {fmtDur}
            </Text>
          ) : null}
          <View
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: dotColor,
            }}
          />
        </Row>
      </Row>
      {summary ? (
        <Text kind="caption" color={tokens.ink2} style={{ marginTop: 6 }} numberOfLines={2}>
          {summary}
        </Text>
      ) : null}
      {lines !== undefined ? (
        <Text kind="caption" mono color={tokens.ink3} style={{ marginTop: 4 }}>
          {lines} lines
        </Text>
      ) : null}
    </Pressable>
  );
}

// ─── error ──────────────────────────────────────────────────────────────────

function ErrorRow({ message }: { message: ErrorBubble }) {
  const tokens = useThemeTokens();
  return (
    <View style={{ paddingHorizontal: 12, paddingVertical: 4, alignItems: "flex-start" }}>
      <View
        style={{
          maxWidth: "85%",
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: tokens.danger,
          backgroundColor: tokens.sunken,
        }}
      >
        <Row gap={6} align="center">
          <Icon name="close" size={12} color={tokens.danger} />
          <Text kind="caption" color={tokens.danger} style={{ flex: 1 }}>
            {message.message}
          </Text>
        </Row>
      </View>
    </View>
  );
}

// ─── streaming variants ─────────────────────────────────────────────────────

interface StreamingMessageProps {
  kind: "stream-tool";
  data: ToolCallState;
  sessionId: string | null;
}

interface StreamingAssistantProps {
  kind: "stream-msg";
  data: AssistantMessage;
}

export type MessageRowInput =
  | { kind: "msg"; data: ChatMessage; sessionId: string | null }
  | StreamingMessageProps
  | StreamingAssistantProps;

// ─── public exports ─────────────────────────────────────────────────────────

interface MessageProps {
  message: ChatMessage;
  sessionId: string | null;
  // Latest todo tool_call_id for this session — drives "isLatest" on the
  // TodoPlanCard so older plan cards lose their Pin footer.
  latestTodoToolId?: string | null;
}

function MessageInner({ message, sessionId, latestTodoToolId }: MessageProps) {
  switch (message.kind) {
    case "user":
      return <UserRow message={message} />;
    case "assistant": {
      // Reasoning-only history rows arrive as { text: "", reasoning: "..." }.
      if (message.text.length === 0 && message.reasoning && message.reasoning.length > 0) {
        return <ReasoningOnlyRow text={message.reasoning} />;
      }
      return <AssistantRow message={message} />;
    }
    case "tool": {
      if (message.name === "todo" && sessionId) {
        const todos = asTodoItems(message.detail?.todos);
        if (todos) {
          // History rows persist tool_id under detail.tool_id; live messages
          // use the chat-store's id (which is itself the tool_call_id).
          const detailToolId =
            typeof message.detail?.tool_id === "string"
              ? (message.detail.tool_id as string)
              : null;
          const ownToolId = detailToolId ?? message.id;
          return (
            <TodoPlanCard
              toolCallId={ownToolId}
              sessionId={sessionId}
              todos={todos}
              status={message.status}
              isLatest={
                latestTodoToolId !== null &&
                latestTodoToolId !== undefined &&
                latestTodoToolId === ownToolId
              }
              createdAt={message.createdAt}
            />
          );
        }
      }
      return <ToolRow data={message} sessionId={sessionId} />;
    }
    case "error":
      return <ErrorRow message={message} />;
  }
}

export const Message = memo(MessageInner);

interface StreamingToolProps {
  data: ToolCallState;
  sessionId: string | null;
}

export const StreamingToolRow = memo(function StreamingToolRow({
  data,
  sessionId,
}: StreamingToolProps) {
  return <ToolRow data={data} sessionId={sessionId} />;
});

export const StreamingAssistantRow = memo(function StreamingAssistantRow({
  message,
}: {
  message: AssistantMessage;
}) {
  return <AssistantRow message={message} streaming />;
});
