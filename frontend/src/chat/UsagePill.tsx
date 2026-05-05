/**
 * UsagePill + UsageSheet — per-session token + cost surface.
 *
 * Visual hierarchy:
 *   - UsagePill: slim, tappable strip rendered below the NavBar in chat
 *     screens. Mono digits, accent-tinted cost when non-zero. Hidden
 *     entirely when the session has no assistant turns.
 *   - UsageSheet: gorhom BottomSheet imperatively presented from the pill.
 *     Big total cost card, three-up token breakdown chips, optional
 *     per-model list when 2+ models were used in the session.
 *
 * Data flows from `getSessionUsage(sessionId)` (TanStack Query). Live updates
 * are handled by invalidating the `["session-usage", id]` query whenever a
 * `message.complete` event lands — see ChatScreen wire-up.
 */
import {
  forwardRef,
  useImperativeHandle,
  useRef,
} from "react";
import { Pressable, View } from "react-native";
import { useQuery } from "@tanstack/react-query";

import {
  Icon,
  Row,
  Sheet,
  type SheetHandle,
  Stack,
  StatusDot,
  Text,
  useThemeTokens,
} from "@/components/ui";
import {
  getSessionUsage,
  type SessionUsage,
  type SessionUsageByModel,
} from "@/api/sessions";

/** Compact 1-2 char count format: 1234 → "1.2K", 1_400_000 → "1.4M". */
function fmtCompact(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1_000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1_000).toFixed(1)}K`;
  if (n < 1_000_000) return `${Math.round(n / 1_000)}K`;
  if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1_000_000)}M`;
}

/** USD with 2-decimal precision; $0.00 for zero so the pill never goes blank. */
function fmtCost(usd: number): string {
  if (!Number.isFinite(usd)) return "$0.00";
  if (usd < 0.01 && usd > 0) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

// ─── pill ──────────────────────────────────────────────────────────────────

export interface UsagePillProps {
  sessionId: string | null;
}

export function UsagePill({ sessionId }: UsagePillProps) {
  const tokens = useThemeTokens();
  const sheetRef = useRef<UsageSheetHandle>(null);

  const usageQuery = useQuery({
    queryKey: ["session-usage", sessionId] as const,
    enabled: !!sessionId,
    queryFn: () =>
      sessionId
        ? getSessionUsage(sessionId)
        : Promise.resolve<SessionUsage>({
            totals: {
              tokensIn: 0,
              tokensOut: 0,
              tokensCached: 0,
              costUsd: 0,
              turns: 0,
            },
            byModel: [],
          }),
    staleTime: 30_000,
  });

  const data = usageQuery.data;
  // Hide entirely when there's nothing meaningful to show — keeps the chat
  // header lean for fresh sessions.
  if (!data || data.totals.turns === 0) return null;

  const totalTokens = data.totals.tokensIn + data.totals.tokensOut;
  const hasCost = data.totals.costUsd > 0;

  return (
    <>
      <Pressable
        onPress={() => sheetRef.current?.present()}
        accessibilityRole="button"
        accessibilityLabel="Show session usage"
        style={({ pressed }) => ({
          paddingHorizontal: 12,
          paddingVertical: 6,
          borderBottomWidth: 1,
          borderBottomColor: tokens.lineSoft,
          backgroundColor: tokens.bg,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Row align="center" justify="space-between" gap={8}>
          <Row align="center" gap={6}>
            <Icon name="bolt" size={11} color={tokens.ink3} />
            <Text kind="caption" color={tokens.ink3}>
              Session usage
            </Text>
          </Row>
          <Row align="center" gap={8}>
            <Text kind="caption" mono color={tokens.ink2}>
              {fmtCompact(totalTokens)} tok
            </Text>
            <Text kind="caption" color={tokens.ink3}>
              ·
            </Text>
            <Text
              kind="caption"
              mono
              color={hasCost ? tokens.accent : tokens.ink3}
              style={{ fontWeight: hasCost ? "600" : "400" }}
            >
              {fmtCost(data.totals.costUsd)}
            </Text>
            <Icon name="chevR" size={12} color={tokens.ink3} />
          </Row>
        </Row>
      </Pressable>
      <UsageSheet ref={sheetRef} usage={data} />
    </>
  );
}

// ─── sheet ─────────────────────────────────────────────────────────────────

interface UsageSheetHandle {
  present: () => void;
  dismiss: () => void;
}

interface UsageSheetProps {
  usage: SessionUsage;
}

const UsageSheet = forwardRef<UsageSheetHandle, UsageSheetProps>(
  function UsageSheet({ usage }, ref) {
    const tokens = useThemeTokens();
    const innerRef = useRef<SheetHandle>(null);

    useImperativeHandle(
      ref,
      () => ({
        present: () => {
          // 16ms warm-up mirrors ActionSheet — gorhom occasionally drops a
          // present() called too soon after a sibling re-render.
          setTimeout(() => innerRef.current?.present(), 16);
        },
        dismiss: () => innerRef.current?.dismiss(),
      }),
      [],
    );

    const showByModel = usage.byModel.length > 1;
    // When there's only one model (typical single-session case), surface its
    // model name in the totals card rather than hiding it inside a one-row list.
    const singleModel = usage.byModel.length === 1 ? usage.byModel[0] : null;

    return (
      <Sheet ref={innerRef} snapPoints={["55%"]} enableDynamicSizing={false}>
        <Stack gap={16} style={{ paddingHorizontal: 16, paddingBottom: 24 }}>
          {/* ── Totals card ─────────────────────────────────────────────── */}
          <View
            style={{
              padding: 16,
              borderRadius: 14,
              backgroundColor: tokens.surface,
              borderWidth: 1,
              borderColor: tokens.line,
            }}
          >
            <Row align="flex-start" justify="space-between" gap={12}>
              <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
                <Text kind="caption" color={tokens.ink3}>
                  Total cost
                </Text>
                <Text
                  kind="display"
                  mono
                  color={usage.totals.costUsd > 0 ? tokens.ink : tokens.ink2}
                >
                  {fmtCost(usage.totals.costUsd)}
                </Text>
                {singleModel ? (
                  <Row gap={6} align="center" style={{ marginTop: 2 }}>
                    <StatusDot kind="idle" />
                    <Text
                      kind="caption"
                      mono
                      color={tokens.ink3}
                      numberOfLines={1}
                    >
                      {singleModel.model}
                    </Text>
                  </Row>
                ) : null}
              </Stack>
              <Stack gap={2} align="flex-end">
                <Text kind="caption" color={tokens.ink3}>
                  Turns
                </Text>
                <Text kind="body-lg" mono color={tokens.ink}>
                  {usage.totals.turns}
                </Text>
              </Stack>
            </Row>
          </View>

          {/* ── Token breakdown ─────────────────────────────────────────── */}
          <Row gap={8}>
            <UsageStat
              label="Input"
              value={fmtCompact(usage.totals.tokensIn)}
              tone="default"
            />
            <UsageStat
              label="Output"
              value={fmtCompact(usage.totals.tokensOut)}
              tone="default"
            />
            <UsageStat
              label="Cached"
              value={fmtCompact(usage.totals.tokensCached)}
              tone="muted"
            />
          </Row>

          {/* ── Per-model list (multi-model only) ───────────────────────── */}
          {showByModel ? (
            <Stack gap={8}>
              <Text kind="micro" color={tokens.ink3} style={{ paddingLeft: 4 }}>
                BY MODEL
              </Text>
              <Stack gap={6}>
                {usage.byModel.map((m) => (
                  <UsageModelRow key={m.model} row={m} />
                ))}
              </Stack>
            </Stack>
          ) : null}

          {/* ── Footer note about pricing accuracy ──────────────────────── */}
          {usage.totals.costUsd === 0 && usage.totals.turns > 0 ? (
            <Text
              kind="caption"
              color={tokens.ink3}
              style={{ lineHeight: 17, paddingHorizontal: 4 }}
            >
              No published price for this model. Tokens are tracked but cost
              shows as $0.
            </Text>
          ) : null}
        </Stack>
      </Sheet>
    );
  },
);

// ─── stat chip + per-model row ─────────────────────────────────────────────

function UsageStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "default" | "muted";
}) {
  const tokens = useThemeTokens();
  const isMuted = tone === "muted";
  return (
    <View
      style={{
        flex: 1,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 10,
        backgroundColor: isMuted ? tokens.sunken : tokens.surface,
        borderWidth: 1,
        borderColor: tokens.lineSoft,
      }}
    >
      <Text kind="micro" color={tokens.ink3} style={{ marginBottom: 4 }}>
        {label}
      </Text>
      <Text
        kind="body"
        mono
        color={isMuted ? tokens.ink2 : tokens.ink}
        style={{ fontWeight: "600" }}
      >
        {value}
      </Text>
    </View>
  );
}

function UsageModelRow({ row }: { row: SessionUsageByModel }) {
  const tokens = useThemeTokens();
  return (
    <View
      style={{
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 10,
        backgroundColor: tokens.surface,
        borderWidth: 1,
        borderColor: tokens.lineSoft,
      }}
    >
      <Row align="center" justify="space-between" gap={8}>
        <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
          <Text kind="body" mono numberOfLines={1} color={tokens.ink}>
            {row.model}
          </Text>
          <Text kind="caption" color={tokens.ink3}>
            {row.provider} · {row.calls} call{row.calls === 1 ? "" : "s"}
          </Text>
        </Stack>
        <Stack gap={2} align="flex-end">
          <Text kind="body" mono color={tokens.ink} style={{ fontWeight: "600" }}>
            {fmtCost(row.costUsd)}
          </Text>
          <Text kind="caption" mono color={tokens.ink3}>
            {fmtCompact(row.tokensIn + row.tokensOut)} tok
          </Text>
        </Stack>
      </Row>
    </View>
  );
}

