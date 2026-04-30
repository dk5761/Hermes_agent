import { memo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { BORDER, MUTED, PANEL, TEXT } from "../config";
import type { AttachmentDTO } from "../api/types";

interface Props {
  attachment: AttachmentDTO;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function PdfAttachmentRowInner({ attachment }: Props) {
  const name = attachment.originalName ?? "document.pdf";
  const preview = attachment.extractedTextPreview;
  return (
    <View style={styles.row}>
      <View style={styles.glyphBox}>
        <Text style={styles.glyphText}>PDF</Text>
      </View>
      <View style={styles.body}>
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        <Text style={styles.size}>{formatBytes(attachment.sizeBytes)}</Text>
        {preview && preview.length > 0 ? (
          <Text style={styles.preview} numberOfLines={3}>
            {preview}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export const PdfAttachmentRow = memo(PdfAttachmentRowInner);

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    gap: 10,
    backgroundColor: PANEL,
    borderWidth: 1,
    borderColor: BORDER,
    borderRadius: 10,
    padding: 10,
  },
  glyphBox: {
    width: 40,
    height: 48,
    borderRadius: 6,
    backgroundColor: "#2A1F1A",
    borderWidth: 1,
    borderColor: BORDER,
    alignItems: "center",
    justifyContent: "center",
  },
  glyphText: {
    color: "#F5A524",
    fontWeight: "700",
    fontSize: 12,
  },
  body: {
    flex: 1,
    minWidth: 0,
  },
  name: {
    color: TEXT,
    fontSize: 13,
    fontWeight: "600",
  },
  size: {
    color: MUTED,
    fontSize: 11,
    marginTop: 2,
  },
  preview: {
    color: MUTED,
    fontSize: 12,
    marginTop: 6,
    fontStyle: "italic",
  },
});
