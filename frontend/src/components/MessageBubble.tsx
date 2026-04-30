import { useState, memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ACCENT, BORDER, DANGER, MUTED, PANEL, TEXT } from "../config";
import type { Message } from "../state/chat-store";
import type { AttachmentDTO } from "../api/types";
import { AttachmentThumbnail } from "./AttachmentThumbnail";
import { PdfAttachmentRow } from "./PdfAttachmentRow";

interface Props {
  message: Message;
  // For streaming bubbles we render outside the main FlatList; this prop
  // lets the chat view tag the bubble visually if needed.
  streaming?: boolean;
  reasoning?: string;
}

function ReasoningToggle({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.reasoningWrap}>
      <Pressable onPress={() => setOpen((v) => !v)} style={styles.reasoningButton}>
        <Text style={styles.reasoningButtonText}>
          {open ? "Hide reasoning" : "Show reasoning"}
        </Text>
      </Pressable>
      {open ? <Text style={styles.reasoningText}>{text}</Text> : null}
    </View>
  );
}

function AttachmentList({ items }: { items: AttachmentDTO[] }) {
  const images = items.filter((a) => a.kind === "image");
  const pdfs = items.filter((a) => a.kind === "pdf" || a.kind === "file");
  return (
    <View style={styles.attachmentBlock}>
      {images.length > 0 ? (
        <View style={styles.thumbRow}>
          {images.map((a) => (
            <AttachmentThumbnail
              key={a.id}
              attachmentId={a.id}
              hasThumb={a.hasThumb}
              size={140}
            />
          ))}
        </View>
      ) : null}
      {pdfs.map((a) => (
        <PdfAttachmentRow key={a.id} attachment={a} />
      ))}
    </View>
  );
}

function UserBubble({
  text,
  attachments,
}: {
  text: string;
  attachments?: AttachmentDTO[];
}) {
  const hasAttachments = (attachments?.length ?? 0) > 0;
  return (
    <View style={[styles.row, styles.rowRight]}>
      <View style={[styles.bubble, styles.user]}>
        {hasAttachments && attachments ? (
          <AttachmentList items={attachments} />
        ) : null}
        {text.length > 0 ? <Text style={styles.userText}>{text}</Text> : null}
      </View>
    </View>
  );
}

function AssistantBubble({
  text,
  reasoning,
  warning,
  streaming,
}: {
  text: string;
  reasoning?: string;
  warning?: string;
  streaming?: boolean;
}) {
  return (
    <View style={[styles.row, styles.rowLeft]}>
      <View style={[styles.bubble, styles.assistant, streaming && styles.streaming]}>
        {text.length === 0 && streaming ? (
          <Text style={styles.assistantText}>...</Text>
        ) : (
          <Text style={styles.assistantText}>{text}</Text>
        )}
        {warning ? <Text style={styles.warning}>! {warning}</Text> : null}
        {reasoning && reasoning.length > 0 ? <ReasoningToggle text={reasoning} /> : null}
      </View>
    </View>
  );
}

function ErrorBubble({ message }: { message: string }) {
  return (
    <View style={[styles.row, styles.rowLeft]}>
      <View style={[styles.bubble, styles.error]}>
        <Text style={styles.errorText}>error: {message}</Text>
      </View>
    </View>
  );
}

function MessageBubbleInner({ message, streaming, reasoning }: Props) {
  if (message.kind === "user")
    return <UserBubble text={message.text} attachments={message.attachments} />;
  if (message.kind === "assistant") {
    return (
      <AssistantBubble
        text={message.text}
        reasoning={reasoning ?? message.reasoning}
        warning={message.warning}
        streaming={streaming}
      />
    );
  }
  if (message.kind === "error") return <ErrorBubble message={message.message} />;
  return null;
}

export const MessageBubble = memo(MessageBubbleInner);

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  rowRight: {
    justifyContent: "flex-end",
  },
  rowLeft: {
    justifyContent: "flex-start",
  },
  bubble: {
    maxWidth: "85%",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
  },
  user: {
    backgroundColor: ACCENT,
    borderColor: ACCENT,
  },
  userText: {
    color: "#FFFFFF",
    fontSize: 15,
  },
  assistant: {
    backgroundColor: PANEL,
    borderColor: BORDER,
  },
  streaming: {
    borderColor: ACCENT,
  },
  assistantText: {
    color: TEXT,
    fontSize: 15,
  },
  warning: {
    color: "#F5A524",
    fontSize: 12,
    marginTop: 6,
  },
  reasoningWrap: {
    marginTop: 8,
    borderTopWidth: 1,
    borderTopColor: BORDER,
    paddingTop: 6,
  },
  reasoningButton: {
    paddingVertical: 4,
  },
  reasoningButtonText: {
    color: MUTED,
    fontSize: 12,
    fontWeight: "600",
  },
  reasoningText: {
    color: MUTED,
    fontSize: 13,
    marginTop: 6,
    fontStyle: "italic",
  },
  error: {
    backgroundColor: "#2A0F12",
    borderColor: DANGER,
  },
  errorText: {
    color: "#FCA5A5",
    fontSize: 13,
  },
  attachmentBlock: {
    gap: 8,
    marginBottom: 6,
  },
  thumbRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
});
