import { memo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { BORDER, DANGER, MUTED, PANEL, TEXT } from "../config";
import type { ToolCallCard as ToolCallCardData, ToolCallState } from "../state/chat-store";

interface Props {
  data: ToolCallCardData | ToolCallState;
}

function statusLabel(s: "running" | "complete" | "error"): string {
  switch (s) {
    case "running":
      return "running";
    case "complete":
      return "done";
    case "error":
      return "error";
  }
}

function ToolCallCardInner({ data }: Props) {
  const [open, setOpen] = useState(false);
  const detailJson = JSON.stringify(data.detail, null, 2);
  return (
    <View style={[styles.row]}>
      <Pressable onPress={() => setOpen((v) => !v)} style={styles.card}>
        <View style={styles.header}>
          <Text style={styles.name} numberOfLines={1}>
            tool: {data.name}
          </Text>
          <Text
            style={[
              styles.status,
              data.status === "error" && styles.statusError,
              data.status === "complete" && styles.statusDone,
            ]}
          >
            {statusLabel(data.status)}
          </Text>
        </View>
        {open ? (
          <Text selectable style={styles.detail}>
            {detailJson}
          </Text>
        ) : null}
      </Pressable>
    </View>
  );
}

export const ToolCallCard = memo(ToolCallCardInner);

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  card: {
    backgroundColor: PANEL,
    borderWidth: 1,
    borderColor: BORDER,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  name: {
    color: TEXT,
    fontSize: 13,
    fontWeight: "600",
    flex: 1,
  },
  status: {
    color: MUTED,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  statusError: {
    color: DANGER,
  },
  statusDone: {
    color: "#7BD389",
  },
  detail: {
    color: MUTED,
    fontFamily: "Menlo",
    fontSize: 11,
    marginTop: 8,
  },
});
