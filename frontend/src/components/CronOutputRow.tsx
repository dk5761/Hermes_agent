import { memo, useCallback } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { BORDER, MUTED, ROW, TEXT } from "@/config";
import { formatRelative } from "@/util/time";
import type { CronOutputSummary } from "@/api/types";

interface CronOutputRowProps {
  output: CronOutputSummary;
  onPress: (output: CronOutputSummary) => void;
}

function CronOutputRowInner({ output, onPress }: CronOutputRowProps) {
  const handlePress = useCallback(() => onPress(output), [output, onPress]);

  return (
    <Pressable
      onPress={handlePress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <Text style={styles.time}>{formatRelative(output.createdAt)}</Text>
      {output.preview ? (
        <Text style={styles.preview} numberOfLines={2}>
          {output.preview}
        </Text>
      ) : (
        <Text style={[styles.preview, styles.muted]}>(empty preview)</Text>
      )}
      <View style={styles.idRow}>
        <Text style={styles.id} numberOfLines={1}>
          {output.id}
        </Text>
      </View>
    </Pressable>
  );
}

export const CronOutputRow = memo(CronOutputRowInner);

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: ROW,
    gap: 4,
    borderBottomColor: BORDER,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  pressed: { opacity: 0.6 },
  time: { color: TEXT, fontSize: 14, fontWeight: "600" },
  preview: { color: MUTED, fontSize: 13 },
  muted: { fontStyle: "italic" },
  idRow: { marginTop: 2 },
  id: { color: MUTED, fontSize: 11, fontFamily: "Menlo" },
});
