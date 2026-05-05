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
import React, { memo, useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";

import type {
  AssistantMessage,
  ErrorBubble,
  Message as ChatMessage,
  SubagentInfo,
  ToolCallCard,
  ToolCallState,
  UserMessage,
} from "@/state/chat-store";
import type { AttachmentDTO } from "@/api/types";
import { useAttachmentsByIds } from "@/hooks/useAttachments";
import { useReasoningCollapse } from "@/state/reasoning-collapse";
import { AttachmentThumbnail } from "@/components/AttachmentThumbnail";
import { PdfAttachmentRow } from "@/components/PdfAttachmentRow";

import { Icon, type IconName } from "./Icon";
import { MarkdownView } from "./Markdown";
import { Row } from "./Row";
import { Stack } from "./Stack";
import { Text } from "./Text";
import { TodoPlanCard } from "./TodoPlanCard";
import type { TodoItem, TodoStatus } from "./TodoStepRow";
import { CitationCardRow, isWebTool } from "./CitationCard";
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
  delegate_task: "flow",
  todo: "check",
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

function UserRow({
  message,
  isActiveMatch,
}: {
  message: UserMessage;
  isActiveMatch?: boolean;
}) {
  const tokens = useThemeTokens();
  const hasText = message.text.length > 0;
  const hasAttachments =
    (message.attachments && message.attachments.length > 0) ||
    (message.attachmentRefs && message.attachmentRefs.length > 0);
  return (
    <View style={{ paddingHorizontal: 12, paddingVertical: 4, alignItems: "flex-end" }}>
      <BubbleHighlight active={!!isActiveMatch} borderRadius={18}>
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
      </BubbleHighlight>
    </View>
  );
}

// ─── assistant ──────────────────────────────────────────────────────────────

function fmtThinkDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1).replace(/\.0$/, "")}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

function ReasoningInline({
  text,
  streaming,
  durationMs,
  messageId,
}: {
  text: string;
  // Live during the turn — auto-expand and label as "Thinking…".
  streaming?: boolean;
  // Time spent reasoning, available once the turn completes.
  durationMs?: number;
  // The owning assistant message's UI id (e.g. `hist-a-42`). When provided,
  // expansion state is persisted across mounts via the reasoning-collapse
  // store so reopening a chat preserves what the user had open.
  messageId?: string;
}) {
  const persisted = useReasoningCollapse((s) =>
    messageId ? !!s.expanded[messageId] : false,
  );
  const setPersisted = useReasoningCollapse((s) => s.setExpanded);
  // Default expansion: collapsed for completed turns (unless the user has
  // previously expanded this exact message), expanded for live ones.
  const [open, setOpen] = useState(!!streaming || persisted);
  const tokens = useThemeTokens();
  // While streaming, keep auto-expanded as new chunks arrive. Once the turn
  // finishes (streaming flips false) we don't force-collapse; that respects
  // a user who already toggled.
  React.useEffect(() => {
    if (streaming) setOpen(true);
  }, [streaming]);
  // If the persisted value updates while mounted (e.g. another instance of
  // the same row re-syncs), reflect it locally — but only when the message
  // isn't actively streaming, so we don't yank the live "Thinking…" panel.
  React.useEffect(() => {
    if (!streaming && messageId) setOpen(persisted);
  }, [persisted, streaming, messageId]);
  const onToggle = useCallback(() => {
    setOpen((v) => {
      const next = !v;
      if (messageId && !streaming) setPersisted(messageId, next);
      return next;
    });
  }, [messageId, streaming, setPersisted]);

  const header = streaming
    ? "Thinking…"
    : durationMs !== undefined
      ? `Thought for ${fmtThinkDuration(durationMs)}`
      : open
        ? "Hide reasoning"
        : "Show reasoning";

  return (
    <View
      className="bg-sunken border border-line-soft"
      style={{
        marginTop: 4,
        marginBottom: 6,
        marginHorizontal: 6,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 8,
      }}
    >
      <Pressable onPress={onToggle}>
        <Row gap={6} align="center">
          <Icon
            name="spark"
            size={12}
            color={streaming ? tokens.accent : tokens.ink3}
          />
          <Text
            kind="caption"
            color={streaming ? tokens.accent : tokens.ink3}
            style={{ fontWeight: "500", flex: 1 }}
          >
            {header}
          </Text>
          {!streaming ? (
            <Icon
              name={open ? "chevU" : "chevD"}
              size={12}
              color={tokens.ink3}
            />
          ) : null}
        </Row>
      </Pressable>
      {open && text.length > 0 ? (
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
  onCopy,
  onRegenerate,
  isActiveMatch,
  quickReplies,
  onQuickReply,
}: {
  message: AssistantMessage;
  streaming?: boolean;
  onCopy?: () => void;
  onRegenerate?: () => void;
  isActiveMatch?: boolean;
  quickReplies?: ReadonlyArray<string>;
  onQuickReply?: (text: string) => void;
}) {
  const tokens = useThemeTokens();
  const hasText = message.text.length > 0;
  const hasReasoning = !!message.reasoning && message.reasoning.length > 0;
  // Hide the action row while a turn is streaming — it's pointless to copy
  // a half-written response, and regenerate would just kill the in-flight
  // turn we're watching.
  const showActions = !streaming && (onCopy || onRegenerate) && hasText;
  return (
    <BubbleHighlight active={!!isActiveMatch} borderRadius={12}>
      <View style={{ paddingHorizontal: 8, paddingVertical: 4, maxWidth: "92%" }}>
      {/* Reasoning lives above the answer (matches Claude/ChatGPT pattern):
          users see the "thought" first, then the response below it. While
          streaming, the block auto-expands and shows "Thinking…"; on
          completion it collapses to "Thought for Ns". */}
      {hasReasoning ? (
        <ReasoningInline
          text={message.reasoning ?? ""}
          streaming={streaming}
          durationMs={message.reasoningDurationMs}
          messageId={message.id}
        />
      ) : null}
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
      {message.interrupted ? (
        <Row gap={4} align="center" style={{ paddingHorizontal: 12, marginTop: 4 }}>
          <Icon name="close" size={10} color={tokens.ink3} />
          <Text kind="caption" color={tokens.ink3}>Stopped</Text>
        </Row>
      ) : null}
      {showActions ? (
        <Row gap={4} align="center" style={{ marginTop: 6, marginLeft: -4 }}>
          {onCopy ? (
            <ActionIconButton name="copy" label="Copy" onPress={onCopy} />
          ) : null}
          {onRegenerate ? (
            <ActionIconButton
              name="refresh"
              label="Regenerate"
              onPress={onRegenerate}
            />
          ) : null}
        </Row>
      ) : null}
      {/* Quick-reply chips — appear under the last assistant turn only.
          Tapping a chip routes to the chat screen which decides whether
          to drop the text into the composer or auto-send. */}
      {!streaming && quickReplies && quickReplies.length > 0 && onQuickReply ? (
        <QuickReplyRow chips={quickReplies} onPick={onQuickReply} />
      ) : null}
      </View>
    </BubbleHighlight>
  );
}

function QuickReplyRow({
  chips,
  onPick,
}: {
  chips: ReadonlyArray<string>;
  onPick: (text: string) => void;
}) {
  const tokens = useThemeTokens();
  return (
    <Row gap={6} align="center" style={{ marginTop: 8, flexWrap: "wrap" }}>
      {chips.map((c) => (
        <Pressable
          key={c}
          onPress={() => onPick(c)}
          accessibilityRole="button"
          accessibilityLabel={`Quick reply: ${c}`}
          style={({ pressed }) => ({
            paddingHorizontal: 10,
            paddingVertical: 6,
            borderRadius: 999,
            borderWidth: 1,
            borderColor: tokens.line,
            backgroundColor: tokens.surface,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Text kind="caption" color={tokens.ink2} style={{ fontWeight: "500" }}>
            {c}
          </Text>
        </Pressable>
      ))}
    </Row>
  );
}

function ActionIconButton({
  name,
  label,
  onPress,
}: {
  name: IconName;
  label: string;
  onPress: () => void;
}) {
  const tokens = useThemeTokens();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        width: 28,
        height: 28,
        borderRadius: 14,
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed ? 0.5 : 1,
      })}
    >
      <Icon name={name} size={14} color={tokens.ink3} />
    </Pressable>
  );
}

// ─── reasoning-only row (history) ───────────────────────────────────────────

function ReasoningOnlyRow({
  text,
  isActiveMatch,
}: {
  text: string;
  isActiveMatch?: boolean;
}) {
  const tokens = useThemeTokens();
  return (
    <View style={{ marginHorizontal: 12, marginVertical: 4 }}>
      <BubbleHighlight active={!!isActiveMatch} borderRadius={12}>
        <View
          className="bg-sunken border border-line-soft"
          style={{
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
      </BubbleHighlight>
    </View>
  );
}

// ─── delegate_task (parent + nested subagents) ───────────────────────────────

function fmtSeconds(secs: number | undefined): string | null {
  if (secs === undefined) return null;
  if (secs < 60) return `${Math.round(secs)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}m ${s}s`;
}

function subagentDot(status: SubagentInfo["status"], tokens: ReturnType<typeof useThemeTokens>): string {
  switch (status) {
    case "running":
      return tokens.accent;
    case "completed":
      return tokens.positive;
    case "interrupted":
      return tokens.warning;
    case "error":
      return tokens.danger;
  }
}

interface DelegateTaskCardProps {
  data: ToolCallCard | ToolCallState;
  subagents: SubagentInfo[];
  sessionId: string | null;
}

function DelegateTaskCard({ data, subagents, sessionId }: DelegateTaskCardProps) {
  const tokens = useThemeTokens();
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);

  const detail = data.detail as Record<string, unknown> | null | undefined;
  const parentDurMs =
    pickNum(detail, "duration_s") !== undefined
      ? (pickNum(detail, "duration_s") as number) * 1000
      : pickNum(detail, "durationMs");
  const parentDur = fmtDuration(parentDurMs);
  const headerDot =
    data.status === "running"
      ? tokens.accent
      : data.status === "error"
        ? tokens.danger
        : tokens.positive;

  const ordered = [...subagents].sort((a, b) => a.taskIndex - b.taskIndex);
  const summary = `${ordered.length} subtask${ordered.length === 1 ? "" : "s"}`;

  const onPressDetail = () => {
    if (!sessionId) return;
    void Haptics.selectionAsync().catch(() => undefined);
    router.push({
      pathname: "/chat/[id]/tool/[toolId]" as const,
      params: { id: sessionId, toolId: data.id },
    });
  };

  return (
    <View
      className="bg-surface border border-line"
      style={{
        marginHorizontal: 6,
        marginVertical: 4,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
      }}
    >
      <Pressable
        onPress={() => setExpanded((v) => !v)}
        onLongPress={onPressDetail}
        hitSlop={8}
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
              <Icon name={iconForTool("delegate_task")} size={12} color={tokens.ink} />
            </View>
            <Text kind="label" mono numberOfLines={1} style={{ flexShrink: 0 }}>
              delegate_task
            </Text>
            <Text kind="caption" color={tokens.ink3} numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>
              {summary}
            </Text>
          </Row>
          <Row gap={6} align="center" style={{ flexShrink: 0 }}>
            {parentDur ? (
              <Text kind="caption" mono color={tokens.ink3}>
                {parentDur}
              </Text>
            ) : null}
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: headerDot }} />
            <Icon
              name={expanded ? "chevU" : "chevD"}
              size={14}
              color={tokens.ink3}
            />
          </Row>
        </Row>
      </Pressable>
      {expanded ? (
        <Stack gap={6} style={{ marginTop: 10 }}>
          {ordered.map((s) => (
            <SubagentRow key={s.subagentId} info={s} />
          ))}
        </Stack>
      ) : (
        <Stack gap={2} style={{ marginTop: 8 }}>
          {ordered.slice(0, 2).map((s) => (
            <Row key={s.subagentId} gap={6} align="center">
              <View
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: subagentDot(s.status, tokens),
                }}
              />
              <Text kind="caption" color={tokens.ink2} numberOfLines={1} style={{ flex: 1 }}>
                {s.taskCount > 1 ? `${s.taskIndex + 1}/${s.taskCount} · ` : ""}
                {s.goal || "(no goal)"}
              </Text>
            </Row>
          ))}
          {ordered.length > 2 ? (
            <Text kind="caption" color={tokens.ink3} style={{ marginLeft: 12 }}>
              +{ordered.length - 2} more
            </Text>
          ) : null}
        </Stack>
      )}
    </View>
  );
}

function SubagentRow({ info }: { info: SubagentInfo }) {
  const tokens = useThemeTokens();
  const dur = fmtSeconds(info.durationSec);
  return (
    <View
      style={{
        backgroundColor: tokens.sunken,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
      }}
    >
      <Row gap={6} align="center" justify="space-between">
        <Row gap={6} align="center" style={{ flex: 1, minWidth: 0 }}>
          <View
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: subagentDot(info.status, tokens),
            }}
          />
          <Text kind="caption" mono color={tokens.ink3} style={{ flexShrink: 0 }}>
            {info.taskCount > 1 ? `${info.taskIndex + 1}/${info.taskCount}` : "·"}
          </Text>
          {info.toolsets && info.toolsets.length > 0 ? (
            <Text kind="caption" mono color={tokens.ink3} style={{ flexShrink: 0 }}>
              {info.toolsets.join(",")}
            </Text>
          ) : null}
        </Row>
        {dur ? (
          <Text kind="caption" mono color={tokens.ink3}>
            {dur}
          </Text>
        ) : null}
      </Row>
      <Text kind="caption" color={tokens.ink2} style={{ marginTop: 4 }} numberOfLines={3}>
        {info.goal || "(no goal)"}
      </Text>
      {info.summary ? (
        <Text kind="caption" color={tokens.ink3} style={{ marginTop: 4 }} numberOfLines={2}>
          {info.summary}
        </Text>
      ) : null}
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
  // Search-in-chat highlighting. When `searchActive` and `isMatch`, paint an
  // accent ring around the row. When `searchActive` and not a match, dim the
  // row so matches stand out.
  searchActive?: boolean;
  isMatch?: boolean;
  isActiveMatch?: boolean;
  // True when this row is the in-flight streaming AssistantMessage. Drives
  // the auto-expanded "Thinking…" reasoning header.
  streaming?: boolean;
  // Inline action affordances rendered below an assistant message — copy
  // text, regenerate (= replay the last user turn). Pass undefined to hide.
  // Regenerate is typically only enabled on the latest assistant message
  // because it truncates the last turn server-side.
  onCopy?: () => void;
  onRegenerate?: () => void;
  /**
   * Long-press handler (~350ms hold) that opens a contextual action menu —
   * copy, regenerate, share, search-similar. Wired by the chat screen so the
   * Message component itself stays unaware of which menu surface is used.
   */
  onLongPress?: () => void;
  /**
   * Quick reply chips rendered under the assistant message. Populated only
   * for the last assistant message (after streaming completes). Tapping a
   * chip routes back through `onQuickReply` so the chat screen owns where
   * the text lands (composer input, auto-send, etc.).
   */
  quickReplies?: ReadonlyArray<string>;
  onQuickReply?: (text: string) => void;
}

function MessageInner({
  message,
  sessionId,
  latestTodoToolId,
  searchActive,
  isMatch,
  isActiveMatch,
  streaming,
  onCopy,
  onRegenerate,
  onLongPress,
  quickReplies,
  onQuickReply,
}: MessageProps) {
  // Active-match flash is scoped to the bubble inside each row variant — so
  // the rainbow overlay covers the visible bubble, not the entire row gutter.
  // Variants that don't have a clear bubble (tool/error cards) currently
  // ignore the flag.
  const activeFlash = !!isActiveMatch;
  let inner: React.ReactNode = null;
  switch (message.kind) {
    case "user":
      inner = <UserRow message={message} isActiveMatch={activeFlash} />;
      break;
    case "assistant": {
      if (
        !streaming &&
        message.text.length === 0 &&
        message.reasoning &&
        message.reasoning.length > 0
      ) {
        inner = (
          <ReasoningOnlyRow
            text={message.reasoning}
            isActiveMatch={activeFlash}
          />
        );
      } else {
        inner = (
          <AssistantRow
            message={message}
            streaming={streaming}
            onCopy={onCopy}
            onRegenerate={onRegenerate}
            isActiveMatch={activeFlash}
            quickReplies={quickReplies}
            onQuickReply={onQuickReply}
          />
        );
      }
      break;
    }
    case "tool": {
      if (message.name === "delegate_task" && message.subagents && message.subagents.length > 0) {
        inner = (
          <DelegateTaskCard
            data={message}
            subagents={message.subagents}
            sessionId={sessionId}
          />
        );
        break;
      }
      if (message.name === "todo" && sessionId) {
        const todos = asTodoItems(message.detail?.todos);
        if (todos) {
          const detailToolId =
            typeof message.detail?.tool_id === "string"
              ? (message.detail.tool_id as string)
              : null;
          const ownToolId = detailToolId ?? message.id;
          inner = (
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
          break;
        }
      }
      // Web tool calls render as link cards (favicon + title + domain) so
      // citations surface inline instead of as opaque tool rows.
      if (isWebTool(message.name)) {
        const durMs =
          typeof message.detail?.["durationMs"] === "number"
            ? (message.detail["durationMs"] as number)
            : typeof message.detail?.["duration_ms"] === "number"
              ? (message.detail["duration_ms"] as number)
              : typeof message.detail?.["duration_s"] === "number"
                ? (message.detail["duration_s"] as number) * 1000
                : undefined;
        inner = (
          <CitationCardRow
            toolName={message.name}
            status={message.status}
            detail={message.detail}
            durationMs={durMs}
          />
        );
        break;
      }
      inner = <ToolRow data={message} sessionId={sessionId} />;
      break;
    }
    case "error":
      inner = <ErrorRow message={message} />;
      break;
  }

  // searchActive drives the in-chat-search dim behavior (non-matches fade to
  // 0.35). The active-match flash is now applied per-row inside each variant
  // via BubbleHighlight, so the wrap is only needed during in-chat search.
  const body = searchActive ? (
    <SearchHighlightWrap isMatch={!!isMatch}>{inner}</SearchHighlightWrap>
  ) : (
    inner
  );

  // Long-press wrapper. Pressable's `onPress` is intentionally undefined so
  // child Pressables (markdown links, action buttons) handle taps as today;
  // only the long-hold gesture bubbles to this outer handler. Haptic on
  // press-in for a tactile cue that the gesture is being captured.
  if (onLongPress) {
    const handle = () => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(
        () => undefined,
      );
      onLongPress();
    };
    return (
      <Pressable
        onLongPress={handle}
        delayLongPress={350}
        accessibilityActions={[
          { name: "longpress", label: "Show message actions" },
        ]}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === "longpress") handle();
        }}
      >
        {body}
      </Pressable>
    );
  }
  return <>{body}</>;
}

// Rainbow stops the active-match overlay cycles through.
const RAINBOW_STOPS = [0, 0.16, 0.33, 0.5, 0.66, 0.83, 1] as const;
const RAINBOW_COLORS = [
  "#ff3b30",
  "#ff9500",
  "#ffcc00",
  "#34c759",
  "#0a84ff",
  "#5e5ce6",
  "#ff3b30",
];

function SearchHighlightWrap({
  isMatch,
  children,
}: {
  // The active-match flash is now scoped per-row (BubbleHighlight inside
  // each variant) so the rainbow tint covers only the bubble, not the row's
  // gutters. SearchHighlightWrap retains only the in-chat-search dim
  // behavior — non-match rows fade to 0.35 while a query is active.
  isMatch: boolean;
  children: React.ReactNode;
}) {
  return <View style={{ opacity: isMatch ? 1 : 0.35 }}>{children}</View>;
}

/**
 * Layout-stable rainbow flash scoped to a single bubble. Wrap the row's
 * inner bubble container with this — the absolute overlay sits on top of
 * children matching the bubble's exact box, so neighbours don't shift and
 * the highlight visually targets the bubble (not the row gutter).
 *
 * Pass `borderRadius` so the overlay clips to the bubble's rounded shape.
 * `active=false` short-circuits to a passthrough wrapping View so the
 * overlay isn't created (and the animation worklet isn't started) when
 * not needed.
 */
function BubbleHighlight({
  active,
  borderRadius = 0,
  children,
}: {
  active: boolean;
  borderRadius?: number;
  children: React.ReactNode;
}) {
  if (!active) return <>{children}</>;
  return (
    <View style={{ position: "relative", overflow: "hidden", borderRadius }}>
      {children}
      <RainbowOverlay borderRadius={borderRadius} />
    </View>
  );
}

function RainbowOverlay({ borderRadius }: { borderRadius: number }) {
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = 0;
    progress.value = withRepeat(
      withTiming(1, { duration: 900, easing: Easing.linear }),
      -1,
      false,
    );
    return () => {
      cancelAnimation(progress);
    };
  }, [progress]);

  const animatedStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      progress.value,
      [...RAINBOW_STOPS],
      RAINBOW_COLORS,
    ),
  }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        { opacity: 0.32, borderRadius },
        animatedStyle,
      ]}
    />
  );
}

export const Message = memo(MessageInner, (prev, next) => {
  if (prev.searchActive !== next.searchActive) return false;
  if (prev.isMatch !== next.isMatch) return false;
  if (prev.isActiveMatch !== next.isActiveMatch) return false;
  if (prev.streaming !== next.streaming) return false;
  if (prev.sessionId !== next.sessionId) return false;
  if (prev.latestTodoToolId !== next.latestTodoToolId) return false;
  if (prev.onCopy !== next.onCopy) return false;
  if (prev.onRegenerate !== next.onRegenerate) return false;
  const a = prev.message;
  const b = next.message;
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  if (a.id !== b.id) return false;
  // Per-kind shallow checks — only the fields that actually change.
  if (a.kind === "user" && b.kind === "user") {
    return (
      a.text === b.text &&
      a.attachments === b.attachments &&
      a.attachmentRefs === b.attachmentRefs
    );
  }
  if (a.kind === "assistant" && b.kind === "assistant") {
    return (
      a.text === b.text &&
      a.reasoning === b.reasoning &&
      a.warning === b.warning &&
      a.reasoningDurationMs === b.reasoningDurationMs &&
      a.interrupted === b.interrupted
    );
  }
  if (a.kind === "tool" && b.kind === "tool") {
    return (
      a.name === b.name &&
      a.status === b.status &&
      a.detail === b.detail &&
      a.subagents === b.subagents
    );
  }
  if (a.kind === "error" && b.kind === "error") {
    return a.message === b.message;
  }
  return false;
});

interface StreamingToolProps {
  data: ToolCallState;
  sessionId: string | null;
}

export const StreamingToolRow = memo(function StreamingToolRow({
  data,
  sessionId,
}: StreamingToolProps) {
  if (data.name === "delegate_task" && data.subagents && data.subagents.length > 0) {
    return (
      <DelegateTaskCard data={data} subagents={data.subagents} sessionId={sessionId} />
    );
  }
  return <ToolRow data={data} sessionId={sessionId} />;
});

export const StreamingAssistantRow = memo(function StreamingAssistantRow({
  message,
}: {
  message: AssistantMessage;
}) {
  return <AssistantRow message={message} streaming />;
});
