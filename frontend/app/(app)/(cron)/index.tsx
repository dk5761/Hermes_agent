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
  Chip,
  EmptyState,
  Icon,
  NavBar,
  NavIcon,
  PhoneSafeArea,
  Row,
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
  listJobs,
  pauseJob,
  resumeJob,
  triggerJob,
} from "@/api/cron";
import type { CronJob } from "@/api/types";
import { formatRelative, toDate } from "@/util/time";
import { OfflineBanner } from "@/components/OfflineBanner";
import { useNetworkStatus } from "@/state/network-status";
import { showToast } from "@/components/ui";

type FilterKey = "all" | "enabled" | "paused" | "notify";

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
    return `${counts.total} job${counts.total === 1 ? "" : "s"} · ${counts.running} running`;
  }, [counts.total, counts.running]);

  return (
    <PhoneSafeArea>
      <NavBar
        large
        title="Cron"
        subtitle={subtitle}
        trailing={<NavIcon name="plus" onPress={onNew} />}
      />
      <OfflineBanner />

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
        // Centered empty state — rendering this outside FlashList avoids the
        // v2 quirk where ListEmptyComponent gets pushed to the bottom of the
        // available list space.
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
        // Cron lists are tiny (typically < 20 entries). FlashList v2
        // vertically-centered a lone row here — likely a `centerContent`
        // default we couldn't override. Plain ScrollView is fine for this
        // size and lays out items strictly top-down.
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
          {filtered.map((item, index) => (
            <CronRow
              key={item.id}
              job={item}
              isLast={index === filtered.length - 1}
              onPress={() => onOpen(item)}
              onLongPress={() => onLongPress(item)}
            />
          ))}
        </ScrollView>
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
}

function CronRow({ job, isLast, onPress, onLongPress }: CronRowProps) {
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

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={300}
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
        <Row gap={6} style={{ marginTop: 4 }}>
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
