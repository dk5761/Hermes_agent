/**
 * Cron list — Stage 7 redesign.
 *
 * Visual target: design/screens-2.jsx::CronList (lines 20-75). All existing
 * cron API wiring (Phase 6) survives unchanged — this is the presentation
 * rebuild only.
 *
 * Filter chips (Notify on / Sort: name) are intentional placeholders per the
 * stage spec; their state is local but no-op until backend support exists.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import * as Haptics from "expo-haptics";

import {
  ActionSheet,
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
  StatusPill,
  Text,
  Button,
  useThemeTokens,
  type ActionSheetHandle,
} from "@/components/ui";
import {
  cronKeys,
  listInboxes,
  listJobs,
  listOutputs,
  pauseJob,
  resumeJob,
  triggerJob,
} from "@/api/cron";
import type { CronInboxDto, CronJob } from "@/api/types";
import { formatRelative, toDate } from "@/util/time";
import { OfflineBanner } from "@/components/OfflineBanner";
import { useNetworkStatus } from "@/state/network-status";
import { showToast } from "@/components/ui";

type FilterKey = "all" | "enabled" | "paused" | "notify";
type TopTab = "jobs" | "outputs";

// Floating tab bar height + safe slack so the last row clears the pill.
const TAB_BOTTOM_PAD = 140;

function isRunning(job: CronJob): boolean {
  return job.state === "running";
}

function isPaused(job: CronJob): boolean {
  return job.state === "paused" || !job.enabled;
}

export default function CronListScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const tokens = useThemeTokens();
  const [filter, setFilter] = useState<FilterKey>("all");
  // Top-level tab — 'jobs' shows the cron list with filter chips, 'outputs'
  // shows one row per job that has produced runs. Local state, resets each
  // time the user backs out of the tab.
  const [tab, setTab] = useState<TopTab>("jobs");
  // OutputsTab pushes its computed subtitle up so the parent NavBar can show
  // "N recent runs · M jobs" without re-running the per-job aggregation here.
  const [outputsSubtitle, setOutputsSubtitle] = useState<string | undefined>(
    undefined,
  );
  // RefreshControl spinner is bound to user pulls only (see comment in
  // (chats)/index.tsx) — binding to `isFetching` causes a stuck spinner on
  // focus-driven invalidation.
  const [pullRefreshing, setPullRefreshing] = useState(false);

  const jobsQuery = useQuery({
    queryKey: cronKeys.jobs(),
    queryFn: listJobs,
    // Refetch on every mount (back-pop or first open) and when the data goes
    // stale on focus (see useFocusEffect below). When a job is currently
    // running, poll every 5s so its state pill updates without manual refresh.
    refetchOnMount: "always",
    refetchInterval: (query) => {
      const data = query.state.data as { jobs: CronJob[] } | undefined;
      const running = data?.jobs?.some((j) => isRunning(j)) ?? false;
      return running ? 5_000 : false;
    },
  });

  // Cron-inbox bindings — per-job destination chip. We index by cron_job_id
  // so each row can render "→ Inbox" (tappable, opens the bound app_session)
  // or "→ Chat" without an extra fetch per row.
  const inboxesQuery = useQuery({
    queryKey: cronKeys.inboxes(),
    queryFn: listInboxes,
    refetchOnMount: "always",
  });
  const bindingsByJobId = useMemo(() => {
    const map = new Map<string, CronInboxDto>();
    for (const i of inboxesQuery.data?.inboxes ?? []) {
      map.set(i.cronJobId, i);
    }
    return map;
  }, [inboxesQuery.data]);

  const invalidateJobs = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: cronKeys.jobs() });
  }, [queryClient]);

  useFocusEffect(useCallback(() => invalidateJobs(), [invalidateJobs]));

  // Long-press actions are wired here so the row can stay a pure presentation
  // component. Each mutation is fire-and-forget — the global toast handler
  // surfaces failures, and onSuccess invalidates the jobs list.
  const pauseMut = useMutation({
    mutationFn: (id: string) => pauseJob(id),
    onSuccess: invalidateJobs,
  });
  const resumeMut = useMutation({
    mutationFn: (id: string) => resumeJob(id),
    onSuccess: invalidateJobs,
  });
  const triggerMut = useMutation({
    mutationFn: (id: string) => triggerJob(id),
    onSuccess: () => {
      invalidateJobs();
    },
  });

  const jobs = jobsQuery.data?.jobs ?? [];

  const counts = useMemo(() => {
    let enabled = 0;
    let paused = 0;
    let running = 0;
    let notify = 0;
    for (const j of jobs) {
      if (isPaused(j)) paused += 1;
      else enabled += 1;
      if (isRunning(j)) running += 1;
      if (j.notifyOnComplete) notify += 1;
    }
    return { enabled, paused, running, notify, total: jobs.length };
  }, [jobs]);

  const filtered = useMemo(() => {
    return jobs.filter((j) => {
      if (filter === "enabled") return !isPaused(j);
      if (filter === "paused") return isPaused(j);
      if (filter === "notify") return j.notifyOnComplete;
      return true;
    });
  }, [jobs, filter]);

  const onOpen = useCallback(
    (job: CronJob) => {
      router.push({
        pathname: "/(cron)/[jobId]",
        params: { jobId: job.id },
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
      // Haptic feedback signals "menu opened". `.catch` swallows the rare
      // case where Haptics is unavailable (e.g. simulator or web).
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(
        () => undefined,
      );
      const paused = isPaused(job);
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
    if (counts.total === 0) return "No jobs yet";
    if (tab === "outputs") {
      // Outputs tab subtitle is derived inside <OutputsTab/> from a per-job
      // outputs aggregate; we surface a stable estimate here so the NavBar
      // never flickers between "n recent runs" and "n jobs". The component
      // updates this once data lands via setOutputsSubtitle below.
      return outputsSubtitle ?? `${counts.total} job${counts.total === 1 ? "" : "s"}`;
    }
    return `${counts.total} job${counts.total === 1 ? "" : "s"} · ${counts.running} running`;
  }, [counts.total, counts.running, tab, outputsSubtitle]);

  return (
    <PhoneSafeArea>
      <NavBar
        large
        title="Cron"
        subtitle={subtitle}
        trailing={
          tab === "jobs" ? <NavIcon name="plus" onPress={onNew} /> : null
        }
      />
      <OfflineBanner />

      {/* Top-level Jobs / Outputs tabs (matches design/screens-2.jsx CronList). */}
      <View style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 }}>
        <SegControl
          options={[
            { value: "jobs", label: "Jobs" },
            { value: "outputs", label: "Outputs" },
          ]}
          value={tab}
          onChange={(v) => setTab(v as TopTab)}
        />
      </View>

      {tab === "jobs" ? (
        <>
          {/* Filter chip row. Horizontal scroll for narrow widths.
              Wrapped in a fixed-height View — a bare horizontal ScrollView in a
              flex-column parent claims extra vertical space (RN quirk), which
              pushed the list ~200px down. Constraining height = 48 fixes it. */}
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
              <Chip
                active={filter === "all"}
                onPress={() => setFilter("all")}
              >{`All`}</Chip>
              <Chip
                active={filter === "enabled"}
                onPress={() => setFilter("enabled")}
              >{`Enabled · ${counts.enabled}`}</Chip>
              <Chip
                active={filter === "paused"}
                onPress={() => setFilter("paused")}
              >{`Paused · ${counts.paused}`}</Chip>
              <Chip
                active={filter === "notify"}
                onPress={() => setFilter("notify")}
              >{`Notify on`}</Chip>
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
                  onRefresh={async () => {
                    setPullRefreshing(true);
                    try {
                      await jobsQuery.refetch();
                    } finally {
                      setPullRefreshing(false);
                    }
                  }}
                  tintColor={tokens.accent}
                  colors={[tokens.accent]}
                />
              }
            >
              {filtered.map((item, index) => {
                const binding = bindingsByJobId.get(item.id);
                return (
                  <CronRow
                    key={item.id}
                    job={item}
                    isLast={index === filtered.length - 1}
                    onPress={() => onOpen(item)}
                    onLongPress={() => onLongPress(item)}
                    {...(binding ? { binding } : {})}
                    onOpenDestination={(b) =>
                      router.push(`/chat/${b.appSessionId}` as never)
                    }
                  />
                );
              })}
            </ScrollView>
          )}
        </>
      ) : (
        <OutputsTab
          jobs={jobs}
          jobsLoading={jobsQuery.isLoading}
          onSubtitle={setOutputsSubtitle}
          onOpen={(job) =>
            router.push(`/(cron)/${encodeURIComponent(job.id)}/outputs` as never)
          }
        />
      )}
      <ActionSheet ref={actionSheetRef} />
    </PhoneSafeArea>
  );
}

// ─── row component ──────────────────────────────────────────────────────────

interface CronRowProps {
  job: CronJob;
  isLast: boolean;
  onPress: () => void;
  onLongPress: () => void;
  /** Cron-inbox binding for this job, when one exists. */
  binding?: CronInboxDto;
  /** Tap the destination chip → navigate into the bound app_session. */
  onOpenDestination?: (binding: CronInboxDto) => void;
}

function CronRow({ job, isLast, onPress, onLongPress, binding, onOpenDestination }: CronRowProps) {
  const tokens = useThemeTokens();
  const running = isRunning(job);
  const paused = isPaused(job);
  // Hermes' jobs.json shape is `schedule: { kind, expr, display }`. We narrow
  // to `expr` here; older snapshots may use `expression` so we tolerate both.
  const sched = job.schedule as Record<string, unknown> | undefined;
  const cronExpr =
    typeof sched?.expr === "string"
      ? (sched.expr as string)
      : typeof sched?.expression === "string"
        ? (sched.expression as string)
        : "";
  const lastRel = formatRelative(job.last_run_at);
  const nextDate = toDate(job.next_run_at);
  const nextRel = nextDate ? formatRelative(nextDate.toISOString()) : "soon";
  // formatRelative renders future dates as past ("Xm ago" with negative diff
  // becomes "just now"); fall back to a forward-looking phrasing.
  const nextLabel = nextDate
    ? nextDate.getTime() > Date.now()
      ? formatForward(nextDate)
      : "soon"
    : "soon";

  // The destination chip needs its own gesture surface so it can navigate
  // to the bound app_session without the row's onPress also firing (RN's
  // nested-Pressable behavior fires both, last-write-wins, so the chip would
  // get clobbered by the cron-detail nav). We render the chip as a SIBLING
  // of the parent Pressable inside an outer View; the parent Pressable wraps
  // only the title/schedule/pill area and the chip claims its own touches.
  const showChip = !!(binding && onOpenDestination);
  return (
    <View
      style={{
        borderBottomWidth: isLast ? 0 : 1,
        borderBottomColor: tokens.lineSoft,
      }}
    >
      <Pressable
        onPress={onPress}
        onLongPress={onLongPress}
        delayLongPress={300}
        style={({ pressed }) => ({
          opacity: pressed ? 0.7 : 1,
          paddingVertical: 14,
          paddingHorizontal: 16,
          paddingRight: showChip ? 96 : 16,
          flexDirection: "row",
          gap: 12,
          alignItems: "flex-start",
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
            backgroundColor: running ? tokens.accentBg : tokens.chip,
            borderWidth: running ? 1 : 0,
            borderColor: running ? `${tokens.accent}88` : "transparent",
          }}
        >
          <Icon name="clock" size={16} color={running ? tokens.accent : tokens.ink2} />
        </View>
        <Stack gap={3} style={{ flex: 1, minWidth: 0 }}>
          <Row gap={8} align="center" justify="space-between">
            <Text
              kind="body-lg"
              numberOfLines={1}
              style={{ fontWeight: "500", flex: 1, minWidth: 0 }}
            >
              {job.name}
            </Text>
            <Row gap={6} align="center" style={{ flexShrink: 0 }}>
              {job.notifyOnComplete ? (
                <Icon name="bell" size={11} color={tokens.ink3} />
              ) : null}
              <Text kind="caption" mono color={tokens.ink3}>
                {lastRel || "never"}
              </Text>
            </Row>
          </Row>
          <Row gap={6} align="center">
            {cronExpr ? (
              <Text kind="caption" mono color={tokens.ink3}>
                {cronExpr}
              </Text>
            ) : null}
            {cronExpr && job.schedule_display ? (
              <Text kind="caption" color={tokens.ink3}>
                ·
              </Text>
            ) : null}
            <Text
              kind="caption"
              color={tokens.ink3}
              numberOfLines={1}
              style={{ flexShrink: 1 }}
            >
              {job.schedule_display}
            </Text>
          </Row>
          <Row gap={6} style={{ marginTop: 4, flexWrap: "wrap" }}>
            {running ? (
              <StatusPill kind="connecting" label="running" />
            ) : paused ? (
              <StatusPill kind="paused" label="paused" />
            ) : (
              <StatusPill kind="online" label={`next ${nextLabel}`} />
            )}
          </Row>
        </Stack>
      </Pressable>
      {showChip && binding && onOpenDestination ? (
        <Pressable
          onPress={() => onOpenDestination(binding)}
          style={({ pressed }) => ({
            position: "absolute",
            right: 16,
            bottom: 14,
            paddingHorizontal: 10,
            paddingVertical: 4,
            borderRadius: 999,
            borderWidth: 1,
            borderColor: tokens.line,
            backgroundColor: pressed ? tokens.chip : tokens.surface,
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
          })}
          accessibilityRole="button"
          accessibilityLabel={
            binding.outputKind === "inbox" ? "Open inbox" : "Open destination chat"
          }
        >
          <Icon
            name={binding.outputKind === "inbox" ? "flow" : "chevR"}
            size={11}
            color={tokens.ink2}
          />
          <Text kind="caption" color={tokens.ink2}>
            {binding.outputKind === "inbox" ? "Inbox" : "In chat"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * Forward-looking variant of `formatRelative`. The shared util is past-only
 * ("4m ago"); for the "next" pill we want "in 4m" / "in 2h" phrasing.
 */
function formatForward(d: Date): string {
  const sec = Math.floor((d.getTime() - Date.now()) / 1000);
  if (sec < 60) return "in <1m";
  const min = Math.floor(sec / 60);
  if (min < 60) return `in ${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `in ${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `in ${day}d`;
  return d.toLocaleDateString();
}

// ─── Outputs tab ────────────────────────────────────────────────────────────

/**
 * Group day fragment of a timestamp ("Today" / "Yesterday" / "Mon" /
 * "Apr 24") for the right side of an Outputs row. Accepts either an
 * epoch-seconds number (the API shape) or a parseable ISO string.
 */
function formatDayFragment(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const d =
    typeof value === "number"
      ? new Date(value * 1000)
      : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const startOfDay = (x: Date): number =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / (24 * 3_600_000));
  if (dayDiff === 0) return "Today";
  if (dayDiff === 1) return "Yesterday";
  if (dayDiff < 7) {
    return d.toLocaleDateString(undefined, { weekday: "short" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface OutputsTabProps {
  jobs: ReadonlyArray<CronJob>;
  jobsLoading: boolean;
  onSubtitle: (s: string | undefined) => void;
  onOpen: (job: CronJob) => void;
}

/**
 * Outputs tab body — one row per job that has at least one output, sorted
 * by the latest output's timestamp. Aggregates per-job output counts +
 * latest preview client-side via parallel useQueries; cron lists are tiny
 * (typically <20 jobs) so the cost is negligible. Adding a server-side
 * `/cron/outputs/aggregate` endpoint is a future optimization if N grows.
 */
function OutputsTab({ jobs, jobsLoading, onSubtitle, onOpen }: OutputsTabProps) {
  const tokens = useThemeTokens();
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const queryClient = useQueryClient();

  // One query per job. React Query dedupes by key, so re-renders don't refire.
  const outputsByJob = useQueries({
    queries: jobs.map((job) => ({
      queryKey: cronKeys.outputs(job.id),
      queryFn: () => listOutputs(job.id),
      staleTime: 30_000,
    })),
  });

  // Build aggregate rows + push the parent's subtitle once data settles.
  const rows = useMemo<OutputsTabRow[]>(() => {
    const out: OutputsTabRow[] = [];
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      if (!job) continue;
      const data = outputsByJob[i]?.data?.outputs ?? [];
      if (data.length === 0) continue;
      // Backend returns newest first — first item is the latest run.
      const latest = data[0];
      if (!latest) continue;
      out.push({
        job,
        latestId: latest.id,
        latestTs: latest.createdAt,
        latestPreview: latest.preview ?? "",
        runs: data.length,
      });
    }
    out.sort((a, b) => (b.latestTs ?? 0) - (a.latestTs ?? 0));
    return out;
  }, [jobs, outputsByJob]);

  // Bubble subtitle up. Stable string so the parent useMemo doesn't churn
  // on every render of OutputsTab.
  const subtitle = useMemo(() => {
    const totalRuns = rows.reduce((acc, r) => acc + r.runs, 0);
    const jobCount = jobs.length;
    return `${totalRuns} recent run${totalRuns === 1 ? "" : "s"} · ${jobCount} job${jobCount === 1 ? "" : "s"}`;
  }, [rows, jobs.length]);

  // Update parent on subtitle change. Cleanup clears the parent's value so
  // when the user flips back to Jobs the subtitle reverts to the jobs phrasing.
  useEffect(() => {
    onSubtitle(subtitle);
    return () => onSubtitle(undefined);
    // We deliberately depend on the string — not the callback — so an unstable
    // setter from the parent doesn't churn this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subtitle]);

  const allLoading =
    jobsLoading || outputsByJob.some((q) => q.isLoading);

  if (allLoading) {
    return (
      <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
        <SkeletonGroup count={4} />
      </View>
    );
  }
  if (rows.length === 0) {
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
      contentContainerStyle={{ paddingTop: 4, paddingBottom: TAB_BOTTOM_PAD }}
      refreshControl={
        <RefreshControl
          refreshing={pullRefreshing}
          onRefresh={async () => {
            setPullRefreshing(true);
            try {
              await Promise.all(
                jobs.map((j) =>
                  queryClient.invalidateQueries({
                    queryKey: cronKeys.outputs(j.id),
                  }),
                ),
              );
            } finally {
              setPullRefreshing(false);
            }
          }}
          tintColor={tokens.accent}
          colors={[tokens.accent]}
        />
      }
    >
      {rows.map((r, idx) => (
        <OutputsByJobRow
          key={r.job.id}
          row={r}
          isLast={idx === rows.length - 1}
          onPress={() => onOpen(r.job)}
        />
      ))}
    </ScrollView>
  );
}

interface OutputsTabRow {
  job: CronJob;
  latestId: string;
  /** Epoch seconds (CronOutputSummary.createdAt). */
  latestTs: number;
  latestPreview: string;
  runs: number;
}

function OutputsByJobRow({
  row,
  isLast,
  onPress,
}: {
  row: OutputsTabRow;
  isLast: boolean;
  onPress: () => void;
}) {
  const tokens = useThemeTokens();
  const dayFrag = formatDayFragment(row.latestTs);
  const sched = row.job.schedule as Record<string, unknown> | undefined;
  const cronExpr =
    typeof sched?.expr === "string" ? (sched.expr as string) : "";
  const scheduleDisplay = row.job.schedule_display ?? cronExpr;

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
          <Text
            kind="body-lg"
            numberOfLines={1}
            style={{ fontWeight: "500", flex: 1, minWidth: 0 }}
          >
            {row.job.name}
          </Text>
          <Text kind="caption" color={tokens.ink3} style={{ flexShrink: 0 }}>
            {dayFrag}
          </Text>
        </Row>
        <Text kind="body" color={tokens.ink2} numberOfLines={2}>
          {row.latestPreview || "(no preview)"}
        </Text>
        <Row gap={6} align="center">
          <Text kind="caption" color={tokens.ink3}>
            {row.runs} run{row.runs === 1 ? "" : "s"}
            {scheduleDisplay ? ` · ${scheduleDisplay}` : ""}
          </Text>
        </Row>
      </Stack>
      <View style={{ alignSelf: "center" }}>
        <Icon name="chevR" size={14} color={tokens.ink3} />
      </View>
    </Pressable>
  );
}
