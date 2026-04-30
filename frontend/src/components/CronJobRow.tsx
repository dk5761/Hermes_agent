import { memo, useCallback } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ACCENT, BORDER, DANGER, MUTED, ROW, TEXT } from "@/config";
import { formatRelative } from "@/util/time";
import { NotifyToggle } from "./NotifyToggle";
import type { CronJob } from "@/api/types";

interface CronJobRowProps {
  job: CronJob;
  onPress: (job: CronJob) => void;
}

function stateColor(state: CronJob["state"]): string {
  if (state === "running") return ACCENT;
  if (state === "failed") return DANGER;
  if (state === "paused") return MUTED;
  return TEXT;
}

function CronJobRowInner({ job, onPress }: CronJobRowProps) {
  const handlePress = useCallback(() => onPress(job), [job, onPress]);

  return (
    <Pressable
      onPress={handlePress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.main}>
        <View style={styles.titleRow}>
          <Text style={styles.title} numberOfLines={1}>
            {job.name || job.id}
          </Text>
          {!job.enabled ? (
            <Text style={styles.badgeMuted}>disabled</Text>
          ) : (
            <Text style={[styles.badge, { color: stateColor(job.state) }]}>
              {String(job.state)}
            </Text>
          )}
        </View>
        <Text style={styles.schedule} numberOfLines={1}>
          {job.schedule_display || "-"}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {job.last_run_at
            ? `last run ${formatRelative(job.last_run_at)}`
            : "never run"}
          {job.last_status ? ` · ${job.last_status}` : ""}
        </Text>
      </View>
      <View style={styles.toggle}>
        <NotifyToggle jobId={job.id} value={job.notifyOnComplete} compact />
      </View>
    </Pressable>
  );
}

export const CronJobRow = memo(CronJobRowInner);

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: ROW,
    gap: 12,
    borderBottomColor: BORDER,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  pressed: { opacity: 0.6 },
  main: { flex: 1, gap: 3 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { color: TEXT, fontSize: 16, fontWeight: "600", flexShrink: 1 },
  badge: { fontSize: 11, fontWeight: "700", textTransform: "uppercase" },
  badgeMuted: { color: MUTED, fontSize: 11, fontWeight: "700", textTransform: "uppercase" },
  schedule: { color: MUTED, fontSize: 13 },
  meta: { color: MUTED, fontSize: 11 },
  toggle: { alignItems: "flex-end" },
});
