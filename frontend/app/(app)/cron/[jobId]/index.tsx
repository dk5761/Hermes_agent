import { useCallback, useMemo } from "react";
import {
  FlatList,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Screen } from "@/components/Screen";
import { Spinner } from "@/components/Spinner";
import { Button } from "@/components/Button";
import { NotifyToggle } from "@/components/NotifyToggle";
import { CronOutputRow } from "@/components/CronOutputRow";
import { cronKeys, getJob, listOutputs } from "@/api/cron";
import type { CronOutputSummary } from "@/api/types";
import { BORDER, MUTED, PANEL, TEXT } from "@/config";
import { formatRelative, toDate } from "@/util/time";

export default function CronJobDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ jobId: string }>();
  const jobId = params.jobId ?? "";

  const jobQuery = useQuery({
    queryKey: cronKeys.job(jobId),
    queryFn: () => getJob(jobId),
    enabled: jobId.length > 0,
  });

  const outputsQuery = useQuery({
    queryKey: cronKeys.outputs(jobId),
    queryFn: () => listOutputs(jobId),
    enabled: jobId.length > 0,
  });

  const onPressOutput = useCallback(
    (output: CronOutputSummary) => {
      router.push({
        pathname: "/cron/[jobId]/output/[outputId]",
        params: { jobId, outputId: output.id },
      });
    },
    [jobId, router],
  );

  const renderItem = useCallback(
    ({ item }: { item: CronOutputSummary }) => (
      <CronOutputRow output={item} onPress={onPressOutput} />
    ),
    [onPressOutput],
  );

  const keyExtractor = useCallback((o: CronOutputSummary) => o.id, []);

  const job = jobQuery.data;
  const headerTitle = useMemo(
    () => (job?.name ? job.name : "Cron job"),
    [job?.name],
  );

  // Sort outputs newest-first; backend may already do this but we don't rely on it.
  const outputs = useMemo(() => {
    const list = outputsQuery.data?.outputs ?? [];
    return [...list].sort((a, b) => b.createdAt - a.createdAt);
  }, [outputsQuery.data?.outputs]);

  return (
    <Screen flat>
      <Stack.Screen options={{ title: headerTitle }} />
      {jobQuery.isLoading || !job ? (
        jobQuery.isError ? (
          <View style={styles.errorWrap}>
            <Text style={styles.error}>Failed to load job.</Text>
            <Button label="Retry" onPress={() => jobQuery.refetch()} />
          </View>
        ) : (
          <Spinner />
        )
      ) : (
        <FlatList
          data={outputs}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={
            <JobHeader
              jobId={job.id}
              name={job.name}
              prompt={job.prompt}
              schedule={job.schedule_display}
              model={job.model}
              deliver={job.deliver}
              state={String(job.state)}
              enabled={job.enabled}
              nextRunAt={job.next_run_at}
              lastRunAt={job.last_run_at}
              lastStatus={job.last_status}
              lastError={job.last_error ?? job.last_delivery_error}
              notifyOnComplete={job.notifyOnComplete}
              outputsCount={outputs.length}
            />
          }
          ListEmptyComponent={
            outputsQuery.isLoading ? (
              <Spinner />
            ) : outputsQuery.isError ? (
              <View style={styles.errorWrap}>
                <Text style={styles.error}>Failed to load outputs.</Text>
                <Button label="Retry" onPress={() => outputsQuery.refetch()} />
              </View>
            ) : (
              <View style={styles.empty}>
                <Text style={styles.emptyText}>No outputs yet.</Text>
                <Text style={styles.emptyHint}>
                  Outputs appear here after the job runs.
                </Text>
              </View>
            )
          }
          refreshControl={
            <RefreshControl
              refreshing={outputsQuery.isFetching || jobQuery.isFetching}
              onRefresh={() => {
                void jobQuery.refetch();
                void outputsQuery.refetch();
              }}
              tintColor={MUTED}
            />
          }
        />
      )}
    </Screen>
  );
}

interface JobHeaderProps {
  jobId: string;
  name: string;
  prompt: string;
  schedule: string;
  model: string | null;
  deliver: string | null;
  state: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  notifyOnComplete: boolean;
  outputsCount: number;
}

function JobHeader(p: JobHeaderProps) {
  const nextRun = toDate(p.nextRunAt);
  return (
    <View style={styles.headerWrap}>
      <View style={styles.card}>
        <Field label="schedule" value={p.schedule} />
        <Field
          label="state"
          value={`${p.enabled ? p.state : "disabled"}${p.lastStatus ? ` · last ${p.lastStatus}` : ""}`}
        />
        <Field
          label="next run"
          value={
            p.enabled && nextRun ? nextRun.toLocaleString() : "(not scheduled)"
          }
        />
        <Field
          label="last run"
          value={p.lastRunAt ? formatRelative(p.lastRunAt) : "never"}
        />
        {p.model ? <Field label="model" value={p.model} /> : null}
        {p.deliver ? <Field label="deliver" value={p.deliver} /> : null}
        {p.lastError ? (
          <Field label="last error" value={p.lastError} danger />
        ) : null}
      </View>

      {p.prompt ? (
        <View style={styles.card}>
          <Text style={styles.cardLabel}>prompt</Text>
          <ScrollView style={styles.promptScroll}>
            <Text style={styles.prompt}>{p.prompt}</Text>
          </ScrollView>
        </View>
      ) : null}

      <View style={styles.toggleWrap}>
        <NotifyToggle jobId={p.jobId} value={p.notifyOnComplete} />
      </View>

      <View style={styles.outputsHeader}>
        <Text style={styles.outputsTitle}>Outputs</Text>
        <Text style={styles.outputsCount}>{p.outputsCount}</Text>
      </View>
    </View>
  );
}

function Field({
  label,
  value,
  danger,
}: {
  label: string;
  value: string;
  danger?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text
        style={[styles.fieldValue, danger && styles.fieldValueDanger]}
        numberOfLines={3}
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  listContent: { paddingBottom: 24 },
  headerWrap: { padding: 16, gap: 12 },
  card: {
    backgroundColor: PANEL,
    borderRadius: 10,
    borderColor: BORDER,
    borderWidth: 1,
    padding: 12,
    gap: 8,
  },
  cardLabel: {
    color: MUTED,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  field: { gap: 2 },
  fieldLabel: {
    color: MUTED,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  fieldValue: { color: TEXT, fontSize: 14 },
  fieldValueDanger: { color: "#FCA5A5" },
  promptScroll: { maxHeight: 160 },
  prompt: { color: TEXT, fontSize: 14, fontFamily: "Menlo", lineHeight: 19 },
  toggleWrap: {},
  outputsHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    paddingHorizontal: 4,
    marginTop: 8,
  },
  outputsTitle: {
    color: TEXT,
    fontSize: 16,
    fontWeight: "700",
  },
  outputsCount: { color: MUTED, fontSize: 12 },
  empty: { padding: 32, alignItems: "center", gap: 4 },
  emptyText: { color: TEXT, fontSize: 14, fontWeight: "600" },
  emptyHint: { color: MUTED, fontSize: 12 },
  errorWrap: { padding: 16, gap: 12 },
  error: { color: "#FCA5A5", fontSize: 14 },
});
