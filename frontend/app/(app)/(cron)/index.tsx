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
import { useCallback, useMemo, useState } from "react";
import {
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
  type ListRenderItem,
} from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";

import {
  Chip,
  EmptyState,
  Icon,
  NavBar,
  NavIcon,
  PhoneSafeArea,
  Row,
  Stack,
  StatusPill,
  Text,
  Button,
  useThemeTokens,
} from "@/components/ui";
import { cronKeys, listJobs } from "@/api/cron";
import type { CronJob } from "@/api/types";
import { formatRelative, toDate } from "@/util/time";

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
  const tokens = useThemeTokens();
  const [filter, setFilter] = useState<FilterKey>("all");

  const jobsQuery = useQuery({
    queryKey: cronKeys.jobs(),
    queryFn: listJobs,
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

  const onNew = useCallback(() => {
    router.push("/(cron)/new" as const);
  }, [router]);

  const subtitle = useMemo(() => {
    if (counts.total === 0) return "No jobs yet";
    return `${counts.total} job${counts.total === 1 ? "" : "s"} · ${counts.running} running`;
  }, [counts.total, counts.running]);

  const renderItem = useCallback<ListRenderItem<CronJob>>(
    ({ item, index }) => (
      <CronRow
        job={item}
        isLast={index === filtered.length - 1}
        onPress={() => onOpen(item)}
      />
    ),
    [filtered.length, onOpen],
  );

  const keyExtractor = useCallback((j: CronJob) => j.id, []);

  return (
    <PhoneSafeArea>
      <NavBar
        large
        title="Cron"
        subtitle={subtitle}
        trailing={<NavIcon name="plus" onPress={onNew} />}
      />

      {/* Filter chip row. Horizontal scroll for narrow widths. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{
          gap: 6,
          paddingHorizontal: 16,
          paddingTop: 4,
          paddingBottom: 12,
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

      <FlatList
        data={filtered}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        contentContainerStyle={{
          paddingBottom: TAB_BOTTOM_PAD,
          flexGrow: 1,
        }}
        ListEmptyComponent={
          jobsQuery.isLoading ? null : (
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
          )
        }
        refreshControl={
          <RefreshControl
            refreshing={jobsQuery.isFetching && !jobsQuery.isLoading}
            onRefresh={() => jobsQuery.refetch()}
            tintColor={tokens.ink3}
          />
        }
      />
    </PhoneSafeArea>
  );
}

// ─── row component ──────────────────────────────────────────────────────────

interface CronRowProps {
  job: CronJob;
  isLast: boolean;
  onPress: () => void;
}

function CronRow({ job, isLast, onPress }: CronRowProps) {
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
