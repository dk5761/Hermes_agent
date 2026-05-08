/**
 * CronJobOutputs — every output of one cron job, drilled in from the
 * Outputs tab on the cron list. Matches design/screens-2.jsx::CronJobOutputs
 * (lines documented in cron-implementation.md §4.3).
 *
 * Layout:
 *   - NavBar "Outputs" + back chevron
 *   - Header card "FROM JOB" with clock icon + job name + schedule + run count
 *   - Vertical list, newest first, each row: ts (mono caption) + chevron +
 *     2-line preview. Tap → push the single-output reader.
 */
import { useCallback, useState } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";

import {
  EmptyState,
  Icon,
  NavBar,
  PhoneSafeArea,
  Row,
  Stack,
  Text,
  useThemeTokens,
} from "@/components/ui";
import { cronKeys, getJob, listOutputs } from "@/api/cron";
import type { CronJob } from "@/api/types";
import { safeBack } from "@/util/nav";

export default function CronJobOutputsScreen() {
  const router = useRouter();
  const tokens = useThemeTokens();
  const params = useLocalSearchParams<{ jobId: string }>();
  const jobId = params.jobId ?? "";
  const [pullRefreshing, setPullRefreshing] = useState(false);

  const jobQuery = useQuery({
    queryKey: cronKeys.job(jobId),
    queryFn: () => getJob(jobId),
    enabled: jobId.length > 0,
    refetchOnMount: "always",
  });
  const outputsQuery = useQuery({
    queryKey: cronKeys.outputs(jobId),
    queryFn: () => listOutputs(jobId),
    enabled: jobId.length > 0,
    refetchOnMount: "always",
  });

  // Refetch on focus so a new run appearing while the user navigates back
  // and forward shows up without a manual pull.
  useFocusEffect(
    useCallback(() => {
      void jobQuery.refetch();
      void outputsQuery.refetch();
      // intentional empty deps — refetch is stable
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
  );

  const job = jobQuery.data as CronJob | undefined;
  const outputs = outputsQuery.data?.outputs ?? [];
  const sched = job?.schedule as Record<string, unknown> | undefined;
  const cronExpr =
    typeof sched?.expr === "string" ? (sched.expr as string) : "";
  const scheduleDisplay = job?.schedule_display ?? cronExpr;

  return (
    <PhoneSafeArea>
      <NavBar title="Outputs" onBack={() => safeBack()} />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 60 }}
        refreshControl={
          <RefreshControl
            refreshing={pullRefreshing}
            onRefresh={async () => {
              setPullRefreshing(true);
              try {
                await Promise.all([jobQuery.refetch(), outputsQuery.refetch()]);
              } finally {
                setPullRefreshing(false);
              }
            }}
            tintColor={tokens.accent}
            colors={[tokens.accent]}
          />
        }
      >
        {/* Header card. The "FROM JOB" label + chip-icon + name keeps the
            user oriented after they drill in from a flat list of outputs. */}
        {job ? (
          <View style={{ padding: 16 }}>
            <Stack gap={8}>
              <Text
                kind="micro"
                color={tokens.ink3}
                style={{ textTransform: "uppercase", letterSpacing: 0.5 }}
              >
                From job
              </Text>
              <Row gap={10} align="center">
                <View
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 8,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: tokens.chip,
                  }}
                >
                  <Icon name="clock" size={14} color={tokens.ink2} />
                </View>
                <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
                  <Text
                    kind="body-lg"
                    numberOfLines={1}
                    style={{ fontWeight: "500" }}
                  >
                    {job.name}
                  </Text>
                  <Text kind="caption" mono color={tokens.ink3}>
                    {scheduleDisplay}
                    {scheduleDisplay && outputs.length > 0 ? " · " : ""}
                    {outputs.length > 0
                      ? `${outputs.length} run${outputs.length === 1 ? "" : "s"}`
                      : ""}
                  </Text>
                </Stack>
              </Row>
            </Stack>
          </View>
        ) : null}

        {outputs.length === 0 ? (
          <View style={{ paddingTop: 40 }}>
            <EmptyState
              icon="terminal"
              title="No runs yet"
              body="Output appears here once the cron fires."
            />
          </View>
        ) : (
          outputs.map((o, idx) => (
            <Pressable
              key={o.id}
              onPress={() =>
                router.push(
                  `/(cron)/${encodeURIComponent(jobId)}/output/${encodeURIComponent(o.id)}` as never,
                )
              }
              style={({ pressed }) => ({
                opacity: pressed ? 0.7 : 1,
                paddingVertical: 14,
                paddingHorizontal: 16,
                borderBottomWidth: idx === outputs.length - 1 ? 0 : 1,
                borderBottomColor: tokens.lineSoft,
              })}
            >
              <Row gap={8} align="center" justify="space-between">
                <Text kind="caption" mono color={tokens.ink3}>
                  {formatOutputTs(o.createdAt)}
                </Text>
                <Icon name="chevR" size={14} color={tokens.ink3} />
              </Row>
              <Text
                kind="body"
                color={tokens.ink2}
                numberOfLines={2}
                style={{ marginTop: 4 }}
              >
                {o.preview ?? "(no preview)"}
              </Text>
            </Pressable>
          ))
        )}
      </ScrollView>
    </PhoneSafeArea>
  );
}

/**
 * "Today · 09:00" / "Yesterday · 09:00" / "Mon · 09:00" / "Apr 24 · 09:00".
 * Matches the spec's `ts` formatting in cron-implementation.md §3.
 */
function formatOutputTs(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const startOfDay = (x: Date): number =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / (24 * 3_600_000));
  let dayPart: string;
  if (dayDiff === 0) dayPart = "Today";
  else if (dayDiff === 1) dayPart = "Yesterday";
  else if (dayDiff < 7)
    dayPart = d.toLocaleDateString(undefined, { weekday: "short" });
  else dayPart = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${dayPart} · ${time}`;
}
