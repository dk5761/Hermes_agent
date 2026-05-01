/**
 * Cron job detail — Stage 7 redesign.
 *
 * Visual target: design/screens-2.jsx::CronDetail (lines 77-150).
 *
 * Layout (top → bottom):
 *   - NavBar (compact) with edit trailing.
 *   - Hero card (schedule_display, cron expr, state pill, meta rows).
 *   - Action row (Run now / Pause·Resume).
 *   - Prompt section (MonoBlock).
 *   - Notify-on-completion toggle row.
 *   - Recent runs list (last 10).
 *   - Footer Edit + Delete buttons.
 *
 * Backend writes go through TanStack mutations that invalidate the jobs
 * list + this job's detail key on success so the list screen reflects the
 * new state when the user navigates back.
 */
import { useCallback, useMemo } from "react";
import { Alert, RefreshControl, ScrollView, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  Button,
  EmptyState,
  ListGroup,
  ListRow,
  MonoBlock,
  NavBar,
  NavIcon,
  PhoneSafeArea,
  Row,
  Section,
  Stack,
  StatusPill,
  Text,
  Toggle,
  useThemeTokens,
} from "@/components/ui";
import {
  cronKeys,
  deleteJob,
  getJob,
  listOutputs,
  pauseJob,
  resumeJob,
  setNotifyPref,
  triggerJob,
} from "@/api/cron";
import type { CronJob, CronJobsResponse, CronOutputSummary } from "@/api/types";
import { formatRelative, toDate } from "@/util/time";

export default function CronJobDetailScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const tokens = useThemeTokens();
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

  const job = jobQuery.data;

  const invalidateJob = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: cronKeys.jobs() });
    void queryClient.invalidateQueries({ queryKey: cronKeys.job(jobId) });
  }, [jobId, queryClient]);

  const pauseMut = useMutation({
    mutationFn: () => pauseJob(jobId),
    onSuccess: invalidateJob,
  });
  const resumeMut = useMutation({
    mutationFn: () => resumeJob(jobId),
    onSuccess: invalidateJob,
  });
  const triggerMut = useMutation({
    mutationFn: () => triggerJob(jobId),
    onSuccess: () => {
      invalidateJob();
      void queryClient.invalidateQueries({ queryKey: cronKeys.outputs(jobId) });
    },
  });
  const deleteMut = useMutation({
    mutationFn: () => deleteJob(jobId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: cronKeys.jobs() });
      router.back();
    },
  });

  // Notify-pref toggle is co-located with the detail view to keep the cache
  // shape consistent (jobs list + this detail). Optimistic update so the
  // switch flips immediately even on a slow network.
  const notifyMut = useMutation({
    mutationFn: (next: boolean) => setNotifyPref(jobId, next),
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey: cronKeys.jobs() });
      await queryClient.cancelQueries({ queryKey: cronKeys.job(jobId) });
      const prevList = queryClient.getQueryData<CronJobsResponse>(
        cronKeys.jobs(),
      );
      const prevJob = queryClient.getQueryData<CronJob>(cronKeys.job(jobId));
      if (prevList) {
        queryClient.setQueryData<CronJobsResponse>(cronKeys.jobs(), {
          jobs: prevList.jobs.map((j) =>
            j.id === jobId ? { ...j, notifyOnComplete: next } : j,
          ),
        });
      }
      if (prevJob) {
        queryClient.setQueryData<CronJob>(cronKeys.job(jobId), {
          ...prevJob,
          notifyOnComplete: next,
        });
      }
      return { prevList, prevJob };
    },
    onError: (_err, _next, ctx) => {
      if (ctx?.prevList) queryClient.setQueryData(cronKeys.jobs(), ctx.prevList);
      if (ctx?.prevJob) queryClient.setQueryData(cronKeys.job(jobId), ctx.prevJob);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: cronKeys.jobs() });
      void queryClient.invalidateQueries({ queryKey: cronKeys.job(jobId) });
      void queryClient.invalidateQueries({ queryKey: cronKeys.prefs() });
    },
  });

  const onPauseToggle = useCallback(() => {
    if (!job) return;
    if (isPaused(job)) resumeMut.mutate();
    else pauseMut.mutate();
  }, [job, pauseMut, resumeMut]);

  const onRunNow = useCallback(() => {
    triggerMut.mutate();
  }, [triggerMut]);

  const onEdit = useCallback(() => {
    router.push({
      pathname: "/(cron)/[jobId]/edit",
      params: { jobId },
    });
  }, [jobId, router]);

  const onDelete = useCallback(() => {
    Alert.alert(
      "Delete job?",
      "This cancels future runs and removes the job permanently.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => deleteMut.mutate(),
        },
      ],
    );
  }, [deleteMut]);

  const onOutput = useCallback(
    (output: CronOutputSummary) => {
      router.push({
        pathname: "/(cron)/[jobId]/output/[outputId]",
        params: { jobId, outputId: output.id },
      });
    },
    [jobId, router],
  );

  // Sort outputs newest-first, cap at 10 per spec.
  const outputs = useMemo(() => {
    const list = outputsQuery.data?.outputs ?? [];
    return [...list].sort((a, b) => b.createdAt - a.createdAt).slice(0, 10);
  }, [outputsQuery.data?.outputs]);

  if (!job) {
    return (
      <PhoneSafeArea>
        <NavBar title="Cron job" onBack={() => router.back()} />
        {jobQuery.isError ? (
          <EmptyState
            icon="close"
            title="Failed to load job"
            body={(jobQuery.error as Error | undefined)?.message}
            action={
              <Button kind="secondary" onPress={() => jobQuery.refetch()}>
                Retry
              </Button>
            }
          />
        ) : null}
      </PhoneSafeArea>
    );
  }

  const cronExpr = readCronExpr(job);
  const paused = isPaused(job);

  return (
    <PhoneSafeArea>
      <NavBar
        title={job.name}
        onBack={() => router.back()}
        trailing={<NavIcon name="edit" onPress={onEdit} />}
      />
      <ScrollView
        contentContainerStyle={{ paddingBottom: 60, paddingTop: 8 }}
        refreshControl={
          <RefreshControl
            refreshing={jobQuery.isFetching || outputsQuery.isFetching}
            onRefresh={() => {
              void jobQuery.refetch();
              void outputsQuery.refetch();
            }}
            tintColor={tokens.ink3}
          />
        }
      >
        <Stack gap={20}>
          {/* Hero card */}
          <View
            style={{
              marginHorizontal: 16,
              padding: 16,
              backgroundColor: tokens.surface,
              borderRadius: 14,
              borderWidth: 1,
              borderColor: tokens.line,
            }}
          >
            <Row align="flex-start" justify="space-between" gap={12}>
              <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
                <Text kind="micro" color={tokens.ink3} className="uppercase">
                  Schedule
                </Text>
                <Text kind="h2">{job.schedule_display}</Text>
                {cronExpr ? (
                  <Text kind="caption" mono color={tokens.ink3}>
                    {cronExpr}
                  </Text>
                ) : null}
              </Stack>
              <StatusPill
                kind={paused ? "paused" : "online"}
                label={paused ? "paused" : "enabled"}
              />
            </Row>
            <View
              style={{
                height: 1,
                backgroundColor: tokens.lineSoft,
                marginVertical: 14,
              }}
            />
            <Stack gap={8}>
              <MetaRow
                label="Next run"
                value={
                  paused
                    ? "(paused)"
                    : formatNext(job.next_run_at) ?? "(not scheduled)"
                }
              />
              <MetaRow
                label="Last run"
                value={job.last_run_at ? formatRelative(job.last_run_at) : "never"}
              />
              {job.last_status ? (
                <MetaRow label="Last status" value={String(job.last_status)} />
              ) : null}
              {job.model ? <MetaRow label="Model" value={job.model} /> : null}
              {job.deliver ? (
                <MetaRow label="Deliver to" value={job.deliver} />
              ) : null}
              {job.last_error ?? job.last_delivery_error ? (
                <MetaRow
                  label="Last error"
                  value={(job.last_error ?? job.last_delivery_error) as string}
                  danger
                />
              ) : null}
            </Stack>
          </View>

          {/* Notify toggle */}
          <ListGroup>
            <ListRow
              icon="bell"
              title="Notify on completion"
              subtitle="Push to all signed-in devices"
              right={
                <Toggle
                  on={job.notifyOnComplete}
                  onChange={(next) => notifyMut.mutate(next)}
                />
              }
            />
          </ListGroup>

          {/* Action row */}
          <Row gap={8} style={{ paddingHorizontal: 16 }}>
            <Button
              kind="accent"
              full
              leftIcon="bolt"
              onPress={onRunNow}
              disabled={triggerMut.isPending}
            >
              {triggerMut.isPending ? "Running…" : "Run now"}
            </Button>
            <Button
              kind="secondary"
              full
              leftIcon={paused ? "play" : "pause"}
              onPress={onPauseToggle}
              disabled={pauseMut.isPending || resumeMut.isPending}
            >
              {paused ? "Resume" : "Pause"}
            </Button>
          </Row>

          {/* Prompt */}
          {job.prompt ? (
            <Section title="Prompt">
              <View style={{ marginHorizontal: 16 }}>
                <MonoBlock>{job.prompt}</MonoBlock>
              </View>
            </Section>
          ) : null}

          {/* Recent runs */}
          <Section title={`Last ${Math.min(outputs.length || 10, 10)} runs`}>
            {outputs.length === 0 ? (
              <View style={{ marginHorizontal: 16 }}>
                <View
                  style={{
                    backgroundColor: tokens.surface,
                    borderRadius: 14,
                    borderWidth: 1,
                    borderColor: tokens.line,
                    padding: 16,
                  }}
                >
                  <Text kind="body" color={tokens.ink3}>
                    {outputsQuery.isLoading
                      ? "Loading runs…"
                      : "No runs yet. Trigger one with “Run now”."}
                  </Text>
                </View>
              </View>
            ) : (
              <View
                style={{
                  marginHorizontal: 16,
                  backgroundColor: tokens.surface,
                  borderRadius: 14,
                  borderWidth: 1,
                  borderColor: tokens.line,
                  overflow: "hidden",
                }}
              >
                {outputs.map((o, i) => (
                  <OutputRow
                    key={o.id}
                    output={o}
                    isLast={i === outputs.length - 1}
                    onPress={() => onOutput(o)}
                  />
                ))}
              </View>
            )}
          </Section>

          {/* Footer actions */}
          <Stack gap={8} style={{ paddingHorizontal: 16, paddingTop: 4 }}>
            <Button kind="secondary" leftIcon="edit" full onPress={onEdit}>
              Edit
            </Button>
            <Button
              kind="danger"
              leftIcon="trash"
              full
              onPress={onDelete}
              disabled={deleteMut.isPending}
            >
              Delete job
            </Button>
          </Stack>
        </Stack>
      </ScrollView>
    </PhoneSafeArea>
  );
}

// ─── helpers ────────────────────────────────────────────────────────────────

function isPaused(job: CronJob): boolean {
  return job.state === "paused" || !job.enabled;
}

function readCronExpr(job: CronJob): string {
  const sched = job.schedule as Record<string, unknown> | undefined;
  if (typeof sched?.expr === "string") return sched.expr;
  if (typeof sched?.expression === "string") return sched.expression as string;
  return "";
}

function formatNext(next: string | null | undefined): string | null {
  const d = toDate(next);
  if (!d) return null;
  if (d.getTime() < Date.now()) return "imminent";
  return d.toLocaleString();
}

interface MetaRowProps {
  label: string;
  value: string;
  danger?: boolean;
}

function MetaRow({ label, value, danger }: MetaRowProps) {
  const tokens = useThemeTokens();
  return (
    <Row align="flex-start" justify="space-between" gap={12}>
      <Text kind="caption" color={tokens.ink3}>
        {label}
      </Text>
      <Text
        kind="caption"
        mono
        color={danger ? tokens.danger : undefined}
        numberOfLines={3}
        style={{ flex: 1, textAlign: "right" }}
      >
        {value}
      </Text>
    </Row>
  );
}

interface OutputRowProps {
  output: CronOutputSummary;
  isLast: boolean;
  onPress: () => void;
}

function OutputRow({ output, isLast, onPress }: OutputRowProps) {
  const tokens = useThemeTokens();
  const ts = toDate(output.createdAt);
  return (
    <View
      style={{
        borderBottomWidth: isLast ? 0 : 1,
        borderBottomColor: tokens.lineSoft,
      }}
    >
      <ListRow
        title={output.preview ?? "Output"}
        subtitle={ts ? ts.toLocaleString() : "(unknown time)"}
        chevron
        onPress={onPress}
      />
    </View>
  );
}
