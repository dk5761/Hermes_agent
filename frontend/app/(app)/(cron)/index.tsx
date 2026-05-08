/**
 * Cron list — Jobs / Outputs split.
 *
 * Visual target: design/screens-2.jsx + cron-implementation.md §4.1.
 * Top-level SegControl picks between two bodies:
 *   - Jobs   → list of all cron jobs (existing behavior).
 *   - Outputs → "one row per job that has outputs", newest first.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";

import {
  ActionSheet,
  Button,
  Chip,
  EmptyState,
  Icon,
  NavBar,
  NavIcon,
  PhoneSafeArea,
  Row,
  SegControl,
  SkeletonGroup,
  Stack,
  Text,
  useThemeTokens,
  type ActionSheetHandle,
} from "@/components/ui";
import {
  cronKeys,
  listJobs,
  listOutputsByJob,
  pauseJob,
  resumeJob,
  triggerJob,
} from "@/api/cron";
import type { CronJob, JobOutputSummary } from "@/api/types";
import { OfflineBanner } from "@/components/OfflineBanner";
import { useNetworkStatus } from "@/state/network-status";
import { showToast } from "@/components/ui";
import { JobRow, isJobPaused, isJobRunning } from "@/components/cron/JobRow";

type FilterKey = "all" | "enabled" | "paused" | "notify";
type Tab = "jobs" | "outputs";

// Floating tab bar height + safe slack so the last row clears the pill.
const TAB_BOTTOM_PAD = 140;

export default function CronListScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const tokens = useThemeTokens();
  const [tab, setTab] = useState<Tab>("jobs");
  const [filter, setFilter] = useState<FilterKey>("all");
  // RefreshControl spinner is bound to user pulls only — binding to
  // `isFetching` causes a stuck spinner on focus-driven invalidation.
  const [pullRefreshing, setPullRefreshing] = useState(false);

  const jobsQuery = useQuery({
    queryKey: cronKeys.jobs(),
    queryFn: listJobs,
    refetchOnMount: "always",
    refetchInterval: (query) => {
      const data = query.state.data as { jobs: CronJob[] } | undefined;
      const running = data?.jobs?.some((j) => isJobRunning(j)) ?? false;
      return running ? 5_000 : false;
    },
  });

  // The Outputs aggregator is FS-backed and cheap; refetch on focus + when
  // a run completes (Phase 5 wires the WS invalidation).
  const outputsByJobQuery = useQuery({
    queryKey: cronKeys.outputsByJob(),
    queryFn: listOutputsByJob,
    refetchOnMount: "always",
    enabled: tab === "outputs",
    staleTime: 30_000,
  });

  const invalidateAll = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: cronKeys.jobs() });
    void queryClient.invalidateQueries({ queryKey: cronKeys.outputsByJob() });
  }, [queryClient]);

  useFocusEffect(useCallback(() => invalidateAll(), [invalidateAll]));

  const pauseMut = useMutation({
    mutationFn: (id: string) => pauseJob(id),
    onSuccess: invalidateAll,
  });
  const resumeMut = useMutation({
    mutationFn: (id: string) => resumeJob(id),
    onSuccess: invalidateAll,
  });
  const triggerMut = useMutation({
    mutationFn: (id: string) => triggerJob(id),
    onSuccess: invalidateAll,
  });

  const jobs = jobsQuery.data?.jobs ?? [];
  const outputItems = outputsByJobQuery.data?.items ?? [];

  const counts = useMemo(() => {
    let enabled = 0;
    let paused = 0;
    let running = 0;
    let notify = 0;
    for (const j of jobs) {
      if (isJobPaused(j)) paused += 1;
      else enabled += 1;
      if (isJobRunning(j)) running += 1;
      if (j.notifyOnComplete) notify += 1;
    }
    return { enabled, paused, running, notify, total: jobs.length };
  }, [jobs]);

  const totalRecentRuns = useMemo(
    () => outputItems.reduce((sum, it) => sum + it.count, 0),
    [outputItems],
  );

  // Build a {jobId → CronJob} index so the Outputs tab can look up name +
  // schedule_display in O(1) per row. Jobs with no match (deleted) render
  // with an "archived" badge.
  const jobsById = useMemo(() => {
    const map = new Map<string, CronJob>();
    for (const j of jobs) map.set(j.id, j);
    return map;
  }, [jobs]);

  const filtered = useMemo(() => {
    return jobs.filter((j) => {
      if (filter === "enabled") return !isJobPaused(j);
      if (filter === "paused") return isJobPaused(j);
      if (filter === "notify") return j.notifyOnComplete;
      return true;
    });
  }, [jobs, filter]);

  const onOpenJob = useCallback(
    (job: CronJob) => {
      router.push({
        pathname: "/(cron)/[jobId]",
        params: { jobId: job.id },
      });
    },
    [router],
  );

  const onOpenJobOutputs = useCallback(
    (jobId: string) => {
      router.push({
        pathname: "/(cron)/[jobId]/outputs",
        params: { jobId },
      });
    },
    [router],
  );

  const online = useNetworkStatus((s) => s.online);

  const onNew = useCallback(() => {
    if (!online) {
      showToast("Connect to the internet to create a new cron job", "info");
      return;
    }
    router.push("/(cron)/new" as const);
  }, [router, online]);

  const onLongPress = useCallback(
    (job: CronJob) => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(
        () => undefined,
      );
      const paused = isJobPaused(job);
      const pauseLabel = paused ? "Resume" : "Pause";
      actionSheetRef.current?.present({
        title: job.name,
        subtitle: paused ? "paused" : undefined,
        actions: [
          {
            id: "run",
            label: "Run now",
            icon: "play",
            onPress: () => triggerMut.mutate(job.id),
          },
          {
            id: "pause",
            label: pauseLabel,
            icon: paused ? "play" : "pause",
            onPress: () =>
              (paused ? resumeMut : pauseMut).mutate(job.id),
          },
        ],
      });
    },
    [pauseMut, resumeMut, triggerMut],
  );

  const actionSheetRef = useRef<ActionSheetHandle>(null);

  const subtitle = useMemo(() => {
    if (tab === "outputs") {
      if (counts.total === 0) return "No jobs yet";
      return `${totalRecentRuns} recent run${totalRecentRuns === 1 ? "" : "s"} · ${counts.total} job${counts.total === 1 ? "" : "s"}`;
    }
    if (counts.total === 0) return "No jobs yet";
    return `${counts.total} job${counts.total === 1 ? "" : "s"} · ${counts.running} running`;
  }, [tab, counts.total, counts.running, totalRecentRuns]);

  const onPullRefresh = useCallback(async () => {
    setPullRefreshing(true);
    try {
      if (tab === "outputs") {
        await Promise.all([jobsQuery.refetch(), outputsByJobQuery.refetch()]);
      } else {
        await jobsQuery.refetch();
      }
    } finally {
      setPullRefreshing(false);
    }
  }, [tab, jobsQuery, outputsByJobQuery]);

  return (
    <PhoneSafeArea>
      <NavBar
        large
        title="Cron"
        subtitle={subtitle}
        trailing={<NavIcon name="plus" onPress={onNew} />}
      />
      <OfflineBanner />

      <View style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 }}>
        <SegControl
          options={[
            { value: "jobs", label: "Jobs" },
            { value: "outputs", label: "Outputs" },
          ]}
          value={tab}
          onChange={(next) => setTab(next as Tab)}
        />
      </View>

      {tab === "jobs" ? (
        <JobsBody
          jobsQuery={jobsQuery}
          filter={filter}
          setFilter={setFilter}
          counts={counts}
          filtered={filtered}
          onOpen={onOpenJob}
          onLongPress={onLongPress}
          onNew={onNew}
          pullRefreshing={pullRefreshing}
          onPullRefresh={onPullRefresh}
          accent={tokens.accent}
        />
      ) : (
        <OutputsBody
          isLoading={outputsByJobQuery.isLoading}
          items={outputItems}
          jobsById={jobsById}
          onOpenJobOutputs={onOpenJobOutputs}
          pullRefreshing={pullRefreshing}
          onPullRefresh={onPullRefresh}
          accent={tokens.accent}
        />
      )}

      <ActionSheet ref={actionSheetRef} />
    </PhoneSafeArea>
  );
}

// ─── Jobs body ──────────────────────────────────────────────────────────

interface JobsBodyProps {
  jobsQuery: ReturnType<typeof useQuery<{ jobs: CronJob[] }>>;
  filter: FilterKey;
  setFilter: (f: FilterKey) => void;
  counts: { enabled: number; paused: number; running: number; notify: number; total: number };
  filtered: CronJob[];
  onOpen: (j: CronJob) => void;
  onLongPress: (j: CronJob) => void;
  onNew: () => void;
  pullRefreshing: boolean;
  onPullRefresh: () => Promise<void>;
  accent: string;
}

function JobsBody({
  jobsQuery,
  filter,
  setFilter,
  counts,
  filtered,
  onOpen,
  onLongPress,
  onNew,
  pullRefreshing,
  onPullRefresh,
  accent,
}: JobsBodyProps) {
  return (
    <>
      {/* Filter chip row. Wrapped in a fixed-height View — a bare horizontal
          ScrollView in a flex-column parent claims extra vertical space (RN
          quirk), pushing the list ~200px down. height=48 fixes it. */}
      <View style={{ height: 48 }}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{
            gap: 6,
            paddingHorizontal: 16,
            paddingTop: 4,
            paddingBottom: 12,
            alignItems: "center",
          }}
        >
          <Chip active={filter === "all"} onPress={() => setFilter("all")}>
            {`All`}
          </Chip>
          <Chip active={filter === "enabled"} onPress={() => setFilter("enabled")}>
            {`Enabled · ${counts.enabled}`}
          </Chip>
          <Chip active={filter === "paused"} onPress={() => setFilter("paused")}>
            {`Paused · ${counts.paused}`}
          </Chip>
          <Chip active={filter === "notify"} onPress={() => setFilter("notify")}>
            {`Notify on`}
          </Chip>
          {/* Sort placeholder per spec — visible but inert. */}
          <Chip>Sort: name</Chip>
        </ScrollView>
      </View>

      {jobsQuery.isLoading ? (
        <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
          <SkeletonGroup count={5} />
        </View>
      ) : filtered.length === 0 ? (
        <View
          style={{
            flex: 1,
            justifyContent: "center",
            alignItems: "center",
            paddingBottom: TAB_BOTTOM_PAD,
          }}
        >
          <EmptyState
            icon="clock"
            title="No cron jobs yet"
            body="Schedule a recurring task."
            action={
              <Button kind="accent" onPress={onNew}>
                New job
              </Button>
            }
          />
        </View>
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{
            paddingTop: 4,
            paddingBottom: TAB_BOTTOM_PAD,
          }}
          refreshControl={
            <RefreshControl
              refreshing={pullRefreshing}
              onRefresh={onPullRefresh}
              tintColor={accent}
              colors={[accent]}
            />
          }
        >
          {filtered.map((item, index) => (
            <JobRow
              key={item.id}
              job={item}
              isLast={index === filtered.length - 1}
              onPress={() => onOpen(item)}
              onLongPress={() => onLongPress(item)}
            />
          ))}
        </ScrollView>
      )}
    </>
  );
}

// ─── Outputs body ───────────────────────────────────────────────────────

interface OutputsBodyProps {
  isLoading: boolean;
  items: JobOutputSummary[];
  jobsById: Map<string, CronJob>;
  onOpenJobOutputs: (jobId: string) => void;
  pullRefreshing: boolean;
  onPullRefresh: () => Promise<void>;
  accent: string;
}

function OutputsBody({
  isLoading,
  items,
  jobsById,
  onOpenJobOutputs,
  pullRefreshing,
  onPullRefresh,
  accent,
}: OutputsBodyProps) {
  const tokens = useThemeTokens();

  if (isLoading) {
    return (
      <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
        <SkeletonGroup count={5} />
      </View>
    );
  }
  if (items.length === 0) {
    return (
      <View
        style={{
          flex: 1,
          justifyContent: "center",
          alignItems: "center",
          paddingBottom: TAB_BOTTOM_PAD,
        }}
      >
        <EmptyState
          icon="terminal"
          title="No runs yet"
          body="Your jobs will appear here once they execute."
        />
      </View>
    );
  }
  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{
        paddingTop: 4,
        paddingBottom: TAB_BOTTOM_PAD,
      }}
      refreshControl={
        <RefreshControl
          refreshing={pullRefreshing}
          onRefresh={onPullRefresh}
          tintColor={accent}
          colors={[accent]}
        />
      }
    >
      {items.map((item, index) => (
        <OutputsByJobRow
          key={item.jobId}
          item={item}
          job={jobsById.get(item.jobId)}
          isLast={index === items.length - 1}
          onPress={() => onOpenJobOutputs(item.jobId)}
          tokens={tokens}
        />
      ))}
    </ScrollView>
  );
}

// ─── Outputs row ────────────────────────────────────────────────────────

interface OutputsByJobRowProps {
  item: JobOutputSummary;
  job: CronJob | undefined;
  isLast: boolean;
  onPress: () => void;
  tokens: ReturnType<typeof useThemeTokens>;
}

function OutputsByJobRow({ item, job, isLast, onPress, tokens }: OutputsByJobRowProps) {
  const archived = !job;
  const name = job?.name ?? `(deleted job)`;
  const scheduleDisplay = job?.schedule_display ?? "—";
  const dayLabel = formatDayFragment(item.latest.createdAt);

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        opacity: pressed ? 0.7 : 1,
        paddingVertical: 14,
        paddingHorizontal: 16,
        flexDirection: "row",
        gap: 12,
        alignItems: "flex-start",
        borderBottomWidth: isLast ? 0 : 1,
        borderBottomColor: tokens.lineSoft,
      })}
    >
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          flexShrink: 0,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: tokens.chip,
        }}
      >
        <Icon name="terminal" size={16} color={tokens.ink2} />
      </View>
      <Stack gap={3} style={{ flex: 1, minWidth: 0 }}>
        <Row gap={8} align="center" justify="space-between">
          <Row gap={6} align="center" style={{ flex: 1, minWidth: 0 }}>
            <Text
              kind="body-lg"
              numberOfLines={1}
              style={{ fontWeight: "500", flexShrink: 1 }}
            >
              {name}
            </Text>
            {archived ? (
              <View
                style={{
                  paddingHorizontal: 6,
                  paddingVertical: 2,
                  borderRadius: 4,
                  backgroundColor: tokens.chip,
                }}
              >
                <Text kind="micro" color={tokens.ink3}>
                  archived
                </Text>
              </View>
            ) : null}
          </Row>
          <Text kind="caption" mono color={tokens.ink3} style={{ flexShrink: 0 }}>
            {dayLabel}
          </Text>
        </Row>
        <Text
          kind="body"
          color={tokens.ink2}
          numberOfLines={2}
          style={{ marginTop: 2 }}
        >
          {item.latest.preview || "—"}
        </Text>
        <Row gap={6} align="center" justify="space-between" style={{ marginTop: 4 }}>
          <Text kind="caption" color={tokens.ink3} numberOfLines={1} style={{ flexShrink: 1 }}>
            {`${item.count} run${item.count === 1 ? "" : "s"} · ${scheduleDisplay}`}
          </Text>
          <Icon name="chevR" size={14} color={tokens.ink3} />
        </Row>
      </Stack>
    </Pressable>
  );
}

// "Today" / "Yesterday" / "Mon" / "Apr 24" — the day fragment for the
// right-aligned timestamp on Outputs rows.
function formatDayFragment(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayMs = 86_400_000;
  const diffDays = Math.round((startOf(now) - startOf(d)) / dayMs);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays > 1 && diffDays < 7) {
    return d.toLocaleDateString(undefined, { weekday: "short" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
