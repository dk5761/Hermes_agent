/**
 * CronJobOutputs — every output of a single cron job, newest first.
 *
 * Visual target: cron-implementation.md §4.3.
 *
 * Reached from:
 *   - Cron > Outputs tab → tap a job row.
 *   - CronDetail "Recent runs" section → tap "See all".
 *
 * Tapping a row pushes /(cron)/[jobId]/output/[outputId] (unchanged from
 * the old in-detail flow).
 */
import { useCallback, useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  EmptyState,
  Icon,
  NavBar,
  PhoneSafeArea,
  Row,
  SkeletonRow,
  Stack,
  Text,
  useThemeTokens,
} from "@/components/ui";
import { cronKeys, getJob, listOutputs } from "@/api/cron";
import type { CronOutputSummary } from "@/api/types";
import { safeBack } from "@/util/nav";

const TAB_BOTTOM_PAD = 60;

export default function CronJobOutputsScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const tokens = useThemeTokens();
  const params = useLocalSearchParams<{ jobId: string }>();
  const jobId = params.jobId;
  const [pullRefreshing, setPullRefreshing] = useState(false);

  // Job lookup is best-effort — the screen still renders if the job has
  // been deleted (outputs survive on disk). Falls back to "(deleted job)".
  const jobQuery = useQuery({
    queryKey: cronKeys.job(jobId ?? ""),
    queryFn: () => getJob(jobId!),
    enabled: !!jobId,
    staleTime: 30_000,
  });

  const outputsQuery = useQuery({
    queryKey: cronKeys.outputs(jobId ?? ""),
    queryFn: () => listOutputs(jobId!),
    enabled: !!jobId,
    refetchOnMount: "always",
    staleTime: 30_000,
  });

  // Refresh on focus so a navigated-back-to screen reflects new runs.
  useFocusEffect(
    useCallback(() => {
      if (!jobId) return;
      void queryClient.invalidateQueries({ queryKey: cronKeys.outputs(jobId) });
    }, [queryClient, jobId]),
  );

  const outputs = useMemo(() => {
    const list = outputsQuery.data?.outputs ?? [];
    // Backend already sorts newest-first; this is defensive for the case
    // where a cached page is still hydrating from a cold start.
    return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [outputsQuery.data?.outputs]);

  const job = jobQuery.data;
  const jobName = job?.name ?? "(deleted job)";
  const scheduleDisplay = job?.schedule_display ?? "—";

  const onOpen = useCallback(
    (outputId: string) => {
      if (!jobId) return;
      router.push({
        pathname: "/(cron)/[jobId]/output/[outputId]",
        params: { jobId, outputId },
      });
    },
    [router, jobId],
  );

  const onPullRefresh = useCallback(async () => {
    setPullRefreshing(true);
    try {
      await Promise.all([
        outputsQuery.refetch(),
        jobQuery.refetch(),
      ]);
    } finally {
      setPullRefreshing(false);
    }
  }, [outputsQuery, jobQuery]);

  if (!jobId) {
    return (
      <PhoneSafeArea>
        <NavBar title="Outputs" onBack={() => safeBack("/(cron)")} />
        <EmptyState icon="terminal" title="Missing job id" />
      </PhoneSafeArea>
    );
  }

  return (
    <PhoneSafeArea>
      <NavBar title="Outputs" onBack={() => safeBack("/(cron)")} />

      {/* Header card — FROM JOB label + name + schedule + run count. */}
      <View
        style={{
          marginHorizontal: 16,
          marginTop: 4,
          marginBottom: 8,
          padding: 16,
          borderRadius: 14,
          backgroundColor: tokens.surface,
          borderWidth: 1,
          borderColor: tokens.line,
        }}
      >
        <Text kind="micro" color={tokens.ink3} style={{ textTransform: "uppercase" }}>
          From job
        </Text>
        <Row gap={10} align="center" style={{ marginTop: 6 }}>
          <View
            style={{
              width: 28,
              height: 28,
              borderRadius: 8,
              backgroundColor: tokens.chip,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name="clock" size={14} color={tokens.ink2} />
          </View>
          <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
            <Text kind="body-lg" numberOfLines={1} style={{ fontWeight: "500" }}>
              {jobName}
            </Text>
            <Text kind="caption" mono color={tokens.ink3}>
              {`${scheduleDisplay} · ${outputs.length} run${outputs.length === 1 ? "" : "s"}`}
            </Text>
          </Stack>
        </Row>
      </View>

      {outputsQuery.isLoading ? (
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
          {[0, 1, 2].map((i) => (
            <View
              key={i}
              style={{
                borderBottomWidth: i < 2 ? 1 : 0,
                borderBottomColor: tokens.lineSoft,
              }}
            >
              <SkeletonRow />
            </View>
          ))}
        </View>
      ) : outputs.length === 0 ? (
        <View
          style={{
            flex: 1,
            justifyContent: "center",
            alignItems: "center",
            paddingBottom: TAB_BOTTOM_PAD,
          }}
        >
          <EmptyState icon="terminal" title="No runs yet" />
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
              tintColor={tokens.accent}
              colors={[tokens.accent]}
            />
          }
        >
          {outputs.map((o, i) => (
            <OutputRow
              key={o.id}
              output={o}
              isLast={i === outputs.length - 1}
              onPress={() => onOpen(o.id)}
            />
          ))}
        </ScrollView>
      )}
    </PhoneSafeArea>
  );
}

interface OutputRowProps {
  output: CronOutputSummary;
  isLast: boolean;
  onPress: () => void;
}

function OutputRow({ output, isLast, onPress }: OutputRowProps) {
  const tokens = useThemeTokens();
  const tsLabel = formatRowTimestamp(output.createdAt);

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        opacity: pressed ? 0.7 : 1,
        paddingVertical: 14,
        paddingHorizontal: 16,
        borderBottomWidth: isLast ? 0 : 1,
        borderBottomColor: tokens.lineSoft,
      })}
    >
      <Row gap={8} align="center" justify="space-between">
        <Text kind="caption" mono color={tokens.ink3}>
          {tsLabel}
        </Text>
        <Icon name="chevR" size={14} color={tokens.ink3} />
      </Row>
      <Text
        kind="body"
        color={tokens.ink2}
        numberOfLines={2}
        style={{ marginTop: 4 }}
      >
        {output.preview || "—"}
      </Text>
    </Pressable>
  );
}

// "Today · 09:00" / "Yesterday · 14:30" / "Mon · 09:00" / "Apr 24 · 09:00".
function formatRowTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayMs = 86_400_000;
  const diffDays = Math.round((startOf(now) - startOf(d)) / dayMs);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  let day: string;
  if (diffDays === 0) day = "Today";
  else if (diffDays === 1) day = "Yesterday";
  else if (diffDays > 1 && diffDays < 7) day = d.toLocaleDateString(undefined, { weekday: "short" });
  else day = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${day} · ${time}`;
}
