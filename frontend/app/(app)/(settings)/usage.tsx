/**
 * Usage — Stage 4 (Usage & costs).
 *
 * Mirrors design/screens-3.jsx::UsageScreen. Hero card with totals + a
 * placeholder daily-spend block (TODO: real chart) + a "By model" ListGroup
 * with ProgressBar fills.
 *
 * Chart is intentionally deferred to a follow-up — this screen renders a
 * MonoBlock with the daily numbers so the data is at least visible. Wire
 * `victory-native` or `react-native-gifted-charts` later.
 */
import { useMemo, useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";

import {
  Button,
  EmptyState,
  ListGroup,
  MonoBlock,
  NavBar,
  PhoneSafeArea,
  ProgressBar,
  Row,
  SegControl,
  Skeleton,
  SkeletonGroup,
  Stack,
  Text,
  useThemeTokens,
} from "@/components/ui";
import { getUsage, type UsageRangeDays } from "@/api/usage";

const RANGE_OPTIONS = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
];

function fmtMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

interface ModelCostRowProps {
  name: string;
  provider?: string;
  pct: number;
  cost: number;
}

function ModelCostRow({ name, provider, pct, cost }: ModelCostRowProps) {
  return (
    <View style={{ paddingVertical: 12, paddingHorizontal: 16, gap: 6 }}>
      <Row justify="space-between" align="baseline">
        <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
          <Text kind="body-lg" mono numberOfLines={1}>
            {name}
          </Text>
          {provider ? (
            <Text kind="caption" mono className="text-ink-3" numberOfLines={1}>
              {provider}
            </Text>
          ) : null}
        </Stack>
        <Text kind="body" mono>
          {fmtMoney(cost)}
        </Text>
      </Row>
      <ProgressBar value={pct} />
    </View>
  );
}

export default function UsageScreen() {
  const router = useRouter();
  const tokens = useThemeTokens();
  const [range, setRange] = useState<UsageRangeDays>(30);

  const usageQ = useQuery({
    queryKey: ["usage", range],
    queryFn: () => getUsage(range),
    staleTime: 30_000,
    retry: false,
  });

  const data = usageQ.data;

  const totalCost = data?.totalCost ?? 0;
  const totalTokens = data?.totalTokens;
  const totalCalls = data?.totalCalls ?? 0;

  const byModel = useMemo(() => {
    const list = data?.byModel ?? [];
    const total = list.reduce((acc, m) => acc + m.cost, 0);
    if (total === 0) return [] as Array<{
      model: string;
      provider?: string;
      cost: number;
      pct: number;
    }>;
    return list
      .slice()
      .sort((a, b) => b.cost - a.cost)
      .map((m) => ({
        model: m.model,
        provider: m.provider,
        cost: m.cost,
        pct: m.cost / total,
      }));
  }, [data]);

  const dailyBlock = useMemo(() => {
    const days = data?.byDay ?? [];
    if (!days.length) return null;
    return days
      .map(
        (d) =>
          `${d.date}  ${fmtMoney(d.cost).padStart(7)}  in=${fmtTokens(
            d.tokensIn,
          )} out=${fmtTokens(d.tokensOut)}`,
      )
      .join("\n");
  }, [data]);

  const isLoading = usageQ.isLoading;
  const isError = usageQ.isError;
  const isEmpty =
    !isLoading &&
    !isError &&
    !!data &&
    totalCost === 0 &&
    (data.byModel.length === 0) &&
    (data.byDay.length === 0);

  return (
    <PhoneSafeArea>
      <NavBar title="Usage" onBack={() => router.back()} />

      <ScrollView
        contentContainerStyle={{ paddingBottom: 60 }}
        refreshControl={
          <RefreshControl
            refreshing={usageQ.isFetching && !usageQ.isLoading}
            onRefresh={() => usageQ.refetch()}
            tintColor={tokens.accent}
            colors={[tokens.accent]}
          />
        }
      >
        <Stack gap={18} style={{ paddingTop: 8 }}>
          <View style={{ paddingHorizontal: 16 }}>
            <SegControl
              options={RANGE_OPTIONS}
              value={String(range)}
              onChange={(v) => {
                const n = Number(v);
                if (n === 7 || n === 30 || n === 90) setRange(n);
              }}
            />
          </View>

          {isLoading ? (
            // Hero card placeholder + by-model rows so the layout doesn't jump
            // once data arrives.
            <Stack gap={16}>
              <View
                className="bg-surface border border-line"
                style={{
                  marginHorizontal: 16,
                  padding: 16,
                  borderRadius: 14,
                  gap: 8,
                }}
              >
                <Skeleton width="30%" height={12} />
                <Skeleton width="50%" height={28} />
                <Skeleton width="70%" height={12} />
              </View>
              <SkeletonGroup count={4} />
            </Stack>
          ) : isError ? (
            <EmptyState
              icon="bolt"
              title="Failed to load usage"
              body={(usageQ.error as Error)?.message ?? "Unknown error"}
              action={
                <Button kind="secondary" onClick={() => usageQ.refetch()}>
                  Retry
                </Button>
              }
            />
          ) : isEmpty ? (
            <EmptyState
              icon="bolt"
              title="No usage yet"
              body="Send a few messages and check back later."
            />
          ) : (
            <>
              {/* Hero card */}
              <View
                className="bg-surface border border-line"
                style={{
                  marginHorizontal: 16,
                  padding: 16,
                  borderRadius: 14,
                }}
              >
                <Stack gap={6}>
                  <Text
                    kind="micro"
                    className="text-ink-3 uppercase"
                  >
                    Total · {range} days
                  </Text>
                  <Text kind="display" mono>
                    {fmtMoney(totalCost)}
                  </Text>
                  {totalTokens ? (
                    <Text kind="caption" mono className="text-ink-3">
                      {fmtTokens(totalTokens.in)} in ·{" "}
                      {fmtTokens(totalTokens.out)} out ·{" "}
                      {fmtTokens(totalTokens.cached)} cached
                    </Text>
                  ) : null}
                </Stack>

                {dailyBlock ? (
                  // TODO: replace with victory-native or react-native-gifted-charts
                  // stacked-bar chart (input / output / cached) once the chart
                  // dep lands. For now the raw daily numbers are visible.
                  <View style={{ marginTop: 14 }}>
                    <MonoBlock>{dailyBlock}</MonoBlock>
                  </View>
                ) : null}
              </View>

              {/* Per-model breakdown */}
              {byModel.length > 0 ? (
                <ListGroup header="By model">
                  {byModel.map((m) => (
                    <ModelCostRow
                      key={m.model}
                      name={m.model}
                      provider={m.provider}
                      pct={m.pct}
                      cost={m.cost}
                    />
                  ))}
                </ListGroup>
              ) : null}

              {/* Footer */}
              <View style={{ paddingHorizontal: 16, paddingTop: 4 }}>
                <Text kind="caption" mono className="text-ink-3">
                  {data?.range.start ?? ""}
                  {data?.range.start && data?.range.end ? " — " : ""}
                  {data?.range.end ?? ""}
                  {totalCalls ? ` · ${totalCalls} API calls` : ""}
                </Text>
              </View>
            </>
          )}
        </Stack>
      </ScrollView>
    </PhoneSafeArea>
  );
}
