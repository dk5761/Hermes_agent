import { memo, useCallback } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { BORDER, DANGER, MUTED, PANEL, TEXT } from "../config";
import type { PendingAttachment } from "../attachments/types";

interface Props {
  pending: PendingAttachment;
  onRemove: (localId: string) => void;
  onRetry: (localId: string) => void;
}

function statusLabel(p: PendingAttachment): string {
  switch (p.status) {
    case "queued":
      return "queued";
    case "uploading":
      return "uploading...";
    case "uploaded":
      return "ready";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
  }
}

function AttachmentChipInner({ pending, onRemove, onRetry }: Props) {
  const onPressX = useCallback(() => {
    onRemove(pending.localId);
  }, [onRemove, pending.localId]);
  const onPressRetry = useCallback(() => {
    onRetry(pending.localId);
  }, [onRetry, pending.localId]);

  const isImage = pending.input.kind === "image";
  const failed = pending.status === "failed";

  return (
    <View style={styles.chip}>
      <View style={styles.tile}>
        {isImage ? (
          // Local file URI from the picker — bypasses cache + signed URL flow.
          <Image
            source={{ uri: pending.input.uri }}
            style={styles.image}
            contentFit="cover"
            cachePolicy="memory"
          />
        ) : (
          <View style={styles.pdfTile}>
            <Text style={styles.pdfText}>PDF</Text>
          </View>
        )}
        <Pressable
          onPress={onPressX}
          accessibilityRole="button"
          accessibilityLabel="remove attachment"
          style={styles.removeBtn}
          hitSlop={6}
        >
          <Text style={styles.removeText}>×</Text>
        </Pressable>
      </View>
      <Text
        style={[styles.label, failed && styles.labelError]}
        numberOfLines={1}
      >
        {statusLabel(pending)}
      </Text>
      {failed ? (
        <Pressable onPress={onPressRetry} hitSlop={4}>
          <Text style={styles.retryText}>retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export const AttachmentChip = memo(AttachmentChipInner);

const TILE_SIZE = 64;

const styles = StyleSheet.create({
  chip: {
    width: TILE_SIZE,
    alignItems: "center",
  },
  tile: {
    width: TILE_SIZE,
    height: TILE_SIZE,
    borderRadius: 8,
    overflow: "hidden",
    backgroundColor: PANEL,
    borderWidth: 1,
    borderColor: BORDER,
  },
  image: {
    width: "100%",
    height: "100%",
  },
  pdfTile: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  pdfText: {
    color: "#F5A524",
    fontSize: 14,
    fontWeight: "700",
  },
  removeBtn: {
    position: "absolute",
    top: 2,
    right: 2,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: "rgba(0,0,0,0.7)",
    alignItems: "center",
    justifyContent: "center",
  },
  removeText: {
    color: TEXT,
    fontSize: 14,
    lineHeight: 14,
    fontWeight: "700",
  },
  label: {
    marginTop: 4,
    color: MUTED,
    fontSize: 10,
  },
  labelError: {
    color: DANGER,
  },
  retryText: {
    color: TEXT,
    fontSize: 11,
    fontWeight: "600",
    textDecorationLine: "underline",
  },
});
