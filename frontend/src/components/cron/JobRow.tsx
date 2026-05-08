/**
 * JobRow — single row in the Cron > Jobs tab.
 *
 * Visual reference: design/screens-2.jsx::CronList row layout. Extracted
 * out of app/(app)/(cron)/index.tsx so the screen file stays focused on
 * tab orchestration and the row stays a pure presentation component.
 */
import { Pressable, View } from "react-native";

import {
  Icon,
  Row,
  Stack,
  StatusPill,
  Text,
  useThemeTokens,
} from "@/components/ui";
import type { CronJob } from "@/api/types";
import { formatRelative, toDate } from "@/util/time";

interface JobRowProps {
  job: CronJob;
  isLast: boolean;
  onPress: () => void;
  onLongPress: () => void;
}

export function isJobRunning(job: CronJob): boolean {
  return job.state === "running";
}

export function isJobPaused(job: CronJob): boolean {
  return job.state === "paused" || !job.enabled;
}

export function JobRow({ job, isLast, onPress, onLongPress }: JobRowProps) {
  const tokens = useThemeTokens();
  const running = isJobRunning(job);
  const paused = isJobPaused(job);
  // Hermes' jobs.json shape is `schedule: { kind, expr, display }`. Older
  // snapshots may use `expression` so we tolerate both.
  const sched = job.schedule as Record<string, unknown> | undefined;
  const cronExpr =
    typeof sched?.expr === "string"
      ? (sched.expr as string)
      : typeof sched?.expression === "string"
        ? (sched.expression as string)
        : "";
  const lastRel = formatRelative(job.last_run_at);
  const nextDate = toDate(job.next_run_at);
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

// Forward-looking variant of formatRelative. The shared util is past-only
// ("4m ago"); for the "next" pill we want "in 4m" / "in 2h" phrasing.
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
