import { useCallback, useMemo, useRef, useState } from "react";
import {
  ActionSheetIOS,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ListRenderItem,
} from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Screen } from "@/components/Screen";
import { MessageBubble } from "@/components/MessageBubble";
import { ToolCallCard } from "@/components/ToolCallCard";
import { ApprovalCard } from "@/components/ApprovalCard";
import { ConnectionStatus } from "@/components/ConnectionStatus";
import { Spinner } from "@/components/Spinner";
import { ComposerAttachments } from "@/components/ComposerAttachments";
import { useChatStream } from "@/ws/use-chat-stream";
import { useChatStore } from "@/state/chat-store";
import { usePendingAttachments } from "@/state/pending-attachments";
import { pickDocument, pickImage, PickerError } from "@/attachments/picker";
import type { AttachmentDTO } from "@/api/types";
import type {
  ApprovalRequest,
  AssistantMessage,
  ChatSessionState,
  Message,
  ToolCallCard as ToolCallCardData,
  ToolCallState,
} from "@/state/chat-store";
import { getMessages } from "@/api/sessions";
import { ACCENT, BG, BORDER, MUTED, PANEL, TEXT } from "@/config";
import type { HermesMessage } from "@/api/types";

// FlatList items are a discriminated union. Streaming bubble + tool calls live
// at the tail (rendered as inverted=false bottom-of-list); we keep a single
// sourceOfTruth ordered list for predictable inverted rendering.
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

// Stable empty list keeps the pending-attachments selector reference-equal
// when no attachments exist for the session.
const EMPTY_PENDING: never[] = [];

// Hermes returns messages whose `content` may be string or structured array.
// We only render flat text bubbles in Phase 3; structured content shows a [...].
function hermesContentToText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const parts: string[] = [];
    for (const item of c) {
      if (typeof item === "string") parts.push(item);
      else if (item && typeof item === "object") {
        const t = (item as Record<string, unknown>)["text"];
        if (typeof t === "string") parts.push(t);
      }
    }
    return parts.join("\n");
  }
  return "";
}

export default function ChatScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const sessionId = typeof params.id === "string" ? params.id : null;
  const sessionState = useChatStore((s) => (sessionId ? s.byId[sessionId] : undefined));
  const stream = useChatStream(sessionId);
  const [input, setInput] = useState("");
  const inputRef = useRef<TextInput>(null);
  const pendingList = usePendingAttachments(
    (s) => (sessionId ? (s.bySession[sessionId] ?? EMPTY_PENDING) : EMPTY_PENDING),
  );
  const addPending = usePendingAttachments((s) => s.add);
  const clearPending = usePendingAttachments((s) => s.clearSession);

  // Initial REST history load — only meaningful once we have a Hermes session.
  // Backend returns {messages: []} when no Hermes session is mapped yet.
  const messagesQuery = useQuery({
    queryKey: ["session-messages", sessionId],
    queryFn: () => (sessionId ? getMessages(sessionId) : Promise.resolve({ messages: [] })),
    enabled: !!sessionId,
  });

  const historyRows = useMemo<Row[]>(() => {
    const apiMsgs: HermesMessage[] = messagesQuery.data?.messages ?? [];
    if (!apiMsgs.length) return [];
    return apiMsgs.map<Row>((m, idx) => {
      const text = hermesContentToText(m.content);
      const role = (m.role as string) ?? "assistant";
      const data: Message =
        role === "user"
          ? {
              kind: "user",
              id: `hist-u-${idx}`,
              text,
              createdAt: new Date().toISOString(),
            }
          : {
              kind: "assistant",
              id: `hist-a-${idx}`,
              text,
              createdAt: new Date().toISOString(),
            };
      return { rowKind: "msg", data };
    });
  }, [messagesQuery.data]);

  // Combined list: stored history first, then in-memory chat-store messages.
  // Note: chat-store messages re-add user messages we sent post-mount, while
  // the REST history covers anything before we connected.
  const rows = useMemo<Row[]>(() => {
    const live = buildRows(sessionState);
    return [...historyRows, ...live];
  }, [historyRows, sessionState]);

  // FlatList inverted: data must be reversed so newest is at the bottom visually.
  const reversed = useMemo(() => rows.slice().reverse(), [rows]);

  // Counts and gating: send is held until every queued/in-flight upload reaches
  // a terminal state. Failed uploads are not auto-skipped — the user retries or
  // removes them explicitly.
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
    // Android fallback uses Alert as a lightweight chooser; replace with a
    // proper bottom-sheet UI later.
    Alert.alert("Add attachment", undefined, [
      { text: "Photo Library", onPress: () => void onPickImage() },
      { text: "Document", onPress: () => void onPickDocument() },
      { text: "Cancel", style: "cancel" },
    ]);
  }, [sessionId, onPickImage, onPickDocument]);

  const renderItem = useCallback<ListRenderItem<Row>>(
    ({ item }) => {
      if (item.rowKind === "msg") {
        if (item.data.kind === "tool") return <ToolCallCard data={item.data as ToolCallCardData} />;
        return <MessageBubble message={item.data} />;
      }
      if (item.rowKind === "stream-tool") {
        return <ToolCallCard data={item.data} />;
      }
      if (item.rowKind === "stream-msg") {
        return <MessageBubble message={item.data} streaming />;
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

  const isStreaming = sessionState?.isStreaming ?? false;
  const hasUploaded = uploadedAttachments.length > 0;
  const sendDisabled =
    isStreaming ||
    uploadingCount > 0 ||
    (input.trim().length === 0 && !hasUploaded);
  const sendHint =
    uploadingCount > 0
      ? `uploading ${uploadingCount}...`
      : failedCount > 0
        ? `${failedCount} failed`
        : null;

  return (
    <Screen flat>
      <Stack.Screen options={{ title: "Chat" }} />
      <View style={styles.root}>
        <ConnectionStatus
          status={stream.status}
          retryInMs={stream.retryInMs}
          onReload={stream.acknowledgeSyncRequired}
        />
        {messagesQuery.isLoading ? <Spinner /> : null}
        <FlatList
          inverted
          data={reversed}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
        />
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          keyboardVerticalOffset={Platform.OS === "ios" ? 88 : 0}
        >
          {sessionId ? <ComposerAttachments appSessionId={sessionId} /> : null}
          {sendHint ? (
            <View style={styles.hintRow}>
              <Text style={styles.hintText}>{sendHint}</Text>
            </View>
          ) : null}
          <View style={styles.composer}>
            <Pressable
              onPress={onAttachPress}
              disabled={!sessionId || isStreaming}
              accessibilityRole="button"
              accessibilityLabel="add attachment"
              style={[
                styles.attachBtn,
                (!sessionId || isStreaming) && styles.attachBtnDisabled,
              ]}
            >
              <Text style={styles.attachBtnText}>+</Text>
            </Pressable>
            <TextInput
              ref={inputRef}
              value={input}
              onChangeText={setInput}
              placeholder={isStreaming ? "Streaming..." : "Send a message"}
              placeholderTextColor={MUTED}
              style={styles.input}
              multiline
              editable={!!sessionId}
            />
            {isStreaming ? (
              <Pressable
                onPress={onAbort}
                style={[styles.sendBtn, styles.stopBtn]}
                accessibilityRole="button"
              >
                <Text style={styles.sendBtnText}>stop</Text>
              </Pressable>
            ) : (
              <Pressable
                onPress={onSend}
                disabled={sendDisabled}
                style={[styles.sendBtn, sendDisabled && styles.sendBtnDisabled]}
                accessibilityRole="button"
              >
                <Text style={styles.sendBtnText}>send</Text>
              </Pressable>
            )}
          </View>
        </KeyboardAvoidingView>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG },
  listContent: { paddingVertical: 8 },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderColor: BORDER,
    backgroundColor: BG,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    backgroundColor: PANEL,
    borderWidth: 1,
    borderColor: BORDER,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: TEXT,
    fontSize: 15,
  },
  sendBtn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: ACCENT,
    borderRadius: 10,
    minWidth: 64,
    alignItems: "center",
    justifyContent: "center",
  },
  sendBtnDisabled: {
    opacity: 0.4,
  },
  stopBtn: {
    backgroundColor: "#5A1A22",
  },
  sendBtnText: {
    color: "#FFFFFF",
    fontWeight: "700",
    fontSize: 14,
  },
  attachBtn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: PANEL,
    borderWidth: 1,
    borderColor: BORDER,
    alignItems: "center",
    justifyContent: "center",
  },
  attachBtnDisabled: {
    opacity: 0.4,
  },
  attachBtnText: {
    color: TEXT,
    fontSize: 20,
    fontWeight: "600",
    lineHeight: 22,
  },
  hintRow: {
    paddingHorizontal: 14,
    paddingTop: 6,
  },
  hintText: {
    color: MUTED,
    fontSize: 12,
  },
});
