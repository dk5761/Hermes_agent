import { memo, useCallback } from "react";
import { Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ACCENT, BORDER, MUTED, PANEL, TEXT } from "@/config";
import { cronKeys, setNotifyPref } from "@/api/cron";
import type { CronJob, CronJobsResponse } from "@/api/types";

interface NotifyToggleProps {
  jobId: string;
  value: boolean;
  // Compact mode renders without label (used in row context).
  compact?: boolean;
  onError?: (err: unknown) => void;
}

function NotifyToggleInner({ jobId, value, compact, onError }: NotifyToggleProps) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (next: boolean) => setNotifyPref(jobId, next),
    onMutate: async (next) => {
      // Optimistic update of the jobs cache so the toggle responds instantly.
      // Snapshot the prior list shape to roll back on error.
      await queryClient.cancelQueries({ queryKey: cronKeys.jobs() });
      const prev = queryClient.getQueryData<CronJobsResponse>(cronKeys.jobs());
      if (prev) {
        queryClient.setQueryData<CronJobsResponse>(cronKeys.jobs(), {
          jobs: prev.jobs.map((j) =>
            j.id === jobId ? { ...j, notifyOnComplete: next } : j,
          ),
        });
      }
      const prevJob = queryClient.getQueryData<CronJob>(cronKeys.job(jobId));
      if (prevJob) {
        queryClient.setQueryData<CronJob>(cronKeys.job(jobId), {
          ...prevJob,
          notifyOnComplete: next,
        });
      }
      return { prev, prevJob };
    },
    onError: (err, _next, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(cronKeys.jobs(), ctx.prev);
      if (ctx?.prevJob) queryClient.setQueryData(cronKeys.job(jobId), ctx.prevJob);
      onError?.(err);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: cronKeys.jobs() });
      void queryClient.invalidateQueries({ queryKey: cronKeys.job(jobId) });
      void queryClient.invalidateQueries({ queryKey: cronKeys.prefs() });
    },
  });

  const onToggle = useCallback(
    (next: boolean) => {
      mutation.mutate(next);
    },
    [mutation],
  );

  if (compact) {
    return (
      <Pressable
        accessibilityRole="switch"
        accessibilityState={{ checked: value, busy: mutation.isPending }}
        onPress={() => onToggle(!value)}
        style={({ pressed }) => [
          styles.compactBtn,
          { borderColor: value ? ACCENT : BORDER, opacity: pressed ? 0.7 : 1 },
        ]}
      >
        <Text style={[styles.compactText, value && styles.compactTextOn]}>
          {value ? "notify on" : "notify off"}
        </Text>
      </Pressable>
    );
  }

  return (
    <View style={styles.row}>
      <View style={styles.labelWrap}>
        <Text style={styles.label}>Notify on completion</Text>
        <Text style={styles.hint}>Push when this job finishes</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onToggle}
        disabled={mutation.isPending}
        trackColor={{ false: PANEL, true: ACCENT }}
        thumbColor={"#FFFFFF"}
      />
    </View>
  );
}

export const NotifyToggle = memo(NotifyToggleInner);

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: PANEL,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: BORDER,
    gap: 12,
  },
  labelWrap: { flex: 1, gap: 2 },
  label: { color: TEXT, fontSize: 14, fontWeight: "600" },
  hint: { color: MUTED, fontSize: 12 },
  compactBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
  },
  compactText: { color: MUTED, fontSize: 11, fontWeight: "600" },
  compactTextOn: { color: ACCENT },
});
