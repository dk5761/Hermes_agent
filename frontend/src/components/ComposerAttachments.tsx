import { memo, useCallback } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { AttachmentChip } from "./AttachmentChip";
import { usePendingAttachments } from "../state/pending-attachments";
import { BORDER } from "../config";

interface Props {
  appSessionId: string;
}

function ComposerAttachmentsInner({ appSessionId }: Props) {
  const list = usePendingAttachments(
    (s) => s.bySession[appSessionId] ?? EMPTY,
  );
  const remove = usePendingAttachments((s) => s.remove);
  const retry = usePendingAttachments((s) => s.retry);

  const onRemove = useCallback(
    (localId: string) => {
      remove(appSessionId, localId);
    },
    [appSessionId, remove],
  );
  const onRetry = useCallback(
    (localId: string) => {
      retry(appSessionId, localId);
    },
    [appSessionId, retry],
  );

  if (list.length === 0) return null;
  return (
    <View style={styles.wrap}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
      >
        {list.map((p) => (
          <AttachmentChip
            key={p.localId}
            pending={p}
            onRemove={onRemove}
            onRetry={onRetry}
          />
        ))}
      </ScrollView>
    </View>
  );
}

// Stable empty reference so the selector doesn't return a new array on each render.
const EMPTY: never[] = [];

export const ComposerAttachments = memo(ComposerAttachmentsInner);

const styles = StyleSheet.create({
  wrap: {
    borderTopWidth: 1,
    borderColor: BORDER,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 4,
  },
  row: {
    gap: 10,
    flexDirection: "row",
  },
});
