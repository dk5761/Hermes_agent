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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActionSheetIOS,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  TextInput,
  View,
  type ListRenderItem,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
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
  useThemeTokens,
  type SheetHandle,
} from "@/components/ui";
import { ApprovalCard } from "@/components/ApprovalCard";
import { ComposerAttachments } from "@/components/ComposerAttachments";
import { useChatStream } from "@/ws/use-chat-stream";
import { useChatStore } from "@/state/chat-store";
import { usePendingAttachments } from "@/state/pending-attachments";
import { pickDocument, pickImage, PickerError } from "@/attachments/picker";
import {
  archiveSession,
  deleteSession,
  getMessages,
  listSessions,
  renameSession,
} from "@/api/sessions";
import type { AttachmentDTO, HistoryRow, SessionDto } from "@/api/types";
import type {
  ApprovalRequest,
  AssistantMessage,
  ChatSessionState,
  Message,
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
function historyRowToUiRow(r: HistoryRow): Row | null {
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
      if (!text && !reasoning) return null;
      return {
        rowKind: "msg",
        data: {
          kind: "assistant",
          id: `hist-a-${r.id}`,
          text,
          ...(reasoning ? { reasoning } : {}),
          ...(warning ? { warning } : {}),
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
  const params = useLocalSearchParams<{ id: string }>();
  const sessionId = typeof params.id === "string" ? params.id : null;
  const router = useRouter();
  const tokens = useThemeTokens();
  const queryClient = useQueryClient();
  const sheetRef = useRef<SheetHandle>(null);

  const sessionState = useChatStore((s) => (sessionId ? s.byId[sessionId] : undefined));
  const stream = useChatStream(sessionId);
  const [input, setInput] = useState("");
  const inputRef = useRef<TextInput>(null);
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

  // Cold-load history.
  const messagesQuery = useQuery({
    queryKey: ["session-messages", sessionId],
    queryFn: () => (sessionId ? getMessages(sessionId) : Promise.resolve({ rows: [] })),
    enabled: !!sessionId,
  });

  const historyRows = useMemo<Row[]>(() => {
    const apiRows: HistoryRow[] = messagesQuery.data?.rows ?? [];
    if (!apiRows.length) return [];
    const out: Row[] = [];
    // Fold each `reasoning` row into the *next* `assistant.message` row's
    // reasoning field so we render a single bubble with a "Show reasoning"
    // toggle instead of two stacked cards. If the reasoning text is identical
    // to the assistant text (some models echo the answer into reasoning),
    // drop it entirely.
    let pendingReasoning: string | null = null;
    for (const r of apiRows) {
      if (r.kind === "reasoning") {
        const text = pickString(r.payload, "text");
        if (text) pendingReasoning = text;
        continue;
      }
      if (r.kind === "assistant.message" && pendingReasoning) {
        const text = pickString(r.payload, "text");
        const explicitReasoning =
          pickString(r.payload, "reasoning") ||
          pickString(r.payload, "reasoning_content");
        // Prefer reasoning embedded in the assistant payload; else attach the
        // pending one. Drop if it duplicates the visible text.
        const merged = explicitReasoning || (pendingReasoning !== text ? pendingReasoning : "");
        const synthetic: HistoryRow = {
          ...r,
          payload: { ...r.payload, reasoning: merged },
        };
        const ui = historyRowToUiRow(synthetic);
        if (ui) out.push(ui);
        pendingReasoning = null;
        continue;
      }
      // Non-assistant follow-up — pending reasoning has no anchor; discard it.
      if (pendingReasoning && r.kind !== "assistant.message") {
        pendingReasoning = null;
      }
      const ui = historyRowToUiRow(r);
      if (ui) out.push(ui);
    }
    return out;
  }, [messagesQuery.data]);

  const rows = useMemo<Row[]>(() => {
    const live = buildRows(sessionState);
    return [...historyRows, ...live];
  }, [historyRows, sessionState]);

  // Inverted FlatList: newest at the bottom visually, so the underlying data
  // array is reversed.
  const reversed = useMemo(() => rows.slice().reverse(), [rows]);

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

  const onAttachPress = useCallback(() => {
    if (!sessionId) return;
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ["Cancel", "Photo Library", "Document"],
          cancelButtonIndex: 0,
        },
        (idx) => {
          if (idx === 1) void onPickImage();
          else if (idx === 2) void onPickDocument();
        },
      );
      return;
    }
    Alert.alert("Add attachment", undefined, [
      { text: "Photo Library", onPress: () => void onPickImage() },
      { text: "Document", onPress: () => void onPickDocument() },
      { text: "Cancel", style: "cancel" },
    ]);
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
            router.back();
          });
        },
      },
    ]);
  }, [sessionId, queryClient, router]);

  const openSheet = useCallback(() => {
    sheetRef.current?.present();
  }, []);

  const dismissSheet = useCallback(() => {
    sheetRef.current?.dismiss();
  }, []);

  // ─── render ───────────────────────────────────────────────────────────────

  const renderItem = useCallback<ListRenderItem<Row>>(
    ({ item }) => {
      if (item.rowKind === "msg") {
        return <MessageRow message={item.data} sessionId={sessionId} />;
      }
      if (item.rowKind === "stream-tool") {
        // Streaming tool calls share the same renderer as completed ones.
        // The Message component takes a ToolCallCard but a ToolCallState has
        // the same shape minus the discriminator — synth one.
        return (
          <MessageRow
            message={{
              kind: "tool",
              id: item.data.id,
              name: item.data.name,
              status: item.data.status,
              detail: item.data.detail,
              createdAt: item.data.createdAt,
            }}
            sessionId={sessionId}
          />
        );
      }
      if (item.rowKind === "stream-msg") {
        return <MessageRow message={item.data} sessionId={sessionId} />;
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
    [sessionId, stream],
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
  // Banner visibility: show whenever we're not in steady "open"/"idle" state,
  // plus a 3s grace once we transition back to open so the user gets a brief
  // "Online" confirmation before the banner disappears.
  const [showOnlineConfirmation, setShowOnlineConfirmation] = useState(false);
  const wasNonOpen = useRef(false);
  useEffect(() => {
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
    (stream.status !== "open" && stream.status !== "idle") ||
    showOnlineConfirmation;

  return (
    <PhoneSafeArea>
      <NavBar
        title={headerTitle}
        onBack={() => router.back()}
        leading={
          <Row gap={6} align="center" style={{ marginLeft: 4 }}>
            <StatusDot kind={statusToDotKind(stream.status)} />
            <Text kind="caption" color={tokens.ink3}>
              {statusLabel(stream.status, stream.retryInMs)}
            </Text>
          </Row>
        }
        trailing={<NavIcon name="more" onPress={openSheet} />}
      />

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
        keyboardVerticalOffset={Platform.OS === "ios" ? 88 : 0}
        style={{ flex: 1 }}
      >
        {/* On a cold open we'd otherwise show a blank list flash before
            history hydrates — replace with skeleton bubbles that mirror the
            real Message row rhythm. */}
        {messagesQuery.isFetching && reversed.length === 0 ? (
          <View style={{ flex: 1 }}>
            <SkeletonChat count={5} />
          </View>
        ) : (
          <FlatList
            inverted
            data={reversed}
            keyExtractor={keyExtractor}
            renderItem={renderItem}
            contentContainerStyle={{ paddingVertical: 12 }}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            style={{ flex: 1 }}
          />
        )}

        {sessionId ? <ComposerAttachments appSessionId={sessionId} /> : null}
        {sendHint ? (
          <View style={{ paddingHorizontal: 16, paddingTop: 4 }}>
            <Text kind="caption" color={tokens.ink3}>
              {sendHint}
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
            {isStreaming ? (
              <Pressable
                onPress={onAbort}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 16,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: tokens.ink,
                }}
              >
                <Icon name="pause" size={14} color={tokens.surface} />
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
      <Sheet ref={sheetRef} snapPoints={["35%"]}>
        <Stack gap={2} style={{ paddingVertical: 8 }}>
          <SheetItem
            label="Search in chat"
            onPress={() => {
              dismissSheet();
              // Placeholder — search-in-chat is not built yet.
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
