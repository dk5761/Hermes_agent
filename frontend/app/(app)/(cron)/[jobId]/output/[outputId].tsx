/**
 * CronOutput — read a single cron run.
 *
 * Visual target: design/screens-2.jsx::CronOutput + cron-implementation.md §4.4.
 *
 * Layout:
 *   - NavBar title is the run timestamp (e.g. "Today · 09:00").
 *   - Trailing icons: copy + share.
 *   - Body:
 *       FROM JOB badge with clock icon + job name
 *       Title (h2) — the first markdown heading from the run content
 *       MarkdownView — remainder of the content (Hermes-cron writes it as
 *       structured markdown: Job ID / Run Time / Schedule / Prompt / Response).
 *
 * Side effects:
 *   - Clears the cron-output unread badge on mount (push-notification land
 *     and in-app open share this code path).
 */
import { useCallback, useEffect, useMemo } from "react";
import {
  Alert,
  ActivityIndicator,
  Pressable,
  ScrollView,
  Share,
  View,
} from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";

import {
  Button,
  EmptyState,
  Icon,
  MarkdownView,
  NavBar,
  NavIcon,
  PhoneSafeArea,
  Row,
  Stack,
  Text,
  showToast,
  useThemeTokens,
} from "@/components/ui";
import { cronKeys, getJob, getOutput } from "@/api/cron";
import { useNotificationsInbox } from "@/state/notifications-inbox";
import { safeBack } from "@/util/nav";

export default function CronOutputDetailScreen() {
  const tokens = useThemeTokens();
  const params = useLocalSearchParams<{ jobId: string; outputId: string }>();
  const jobId = params.jobId ?? "";
  const outputId = params.outputId ?? "";

  const jobQuery = useQuery({
    queryKey: cronKeys.job(jobId),
    queryFn: () => getJob(jobId),
    enabled: jobId.length > 0,
  });
  const outputQuery = useQuery({
    queryKey: cronKeys.output(jobId, outputId),
    queryFn: () => getOutput(jobId, outputId),
    enabled: jobId.length > 0 && outputId.length > 0,
  });

  // Clear unread badge on land — covers both push-tap and in-app entry.
  useEffect(() => {
    if (!outputId) return;
    useNotificationsInbox.getState().markCronOutputRead(outputId);
  }, [outputId]);

  const job = jobQuery.data;
  const output = outputQuery.data;

  const headerTitle = useMemo(
    () => (output ? formatNavTs(output.createdAt) : "Output"),
    [output],
  );

  // Pull the first markdown heading off the content as the on-page H2.
  // If no heading is present we leave the page title empty so we don't
  // double up with the NavBar timestamp.
  const { pageTitle, body } = useMemo(() => {
    if (!output?.content) return { pageTitle: "", body: "" };
    const lines = output.content.split("\n");
    let titleLine = "";
    let rest = output.content;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const m = /^#\s+(.+)$/.exec(trimmed);
      if (m) {
        titleLine = m[1] ?? "";
        rest = lines.slice(i + 1).join("\n").trim();
      }
      break;
    }
    return { pageTitle: titleLine, body: rest };
  }, [output]);

  const onCopy = useCallback(async (): Promise<void> => {
    if (!output?.content) return;
    try {
      await Clipboard.setStringAsync(output.content);
      showToast("Copied output to clipboard");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Copy failed");
    }
  }, [output]);

  const onShare = useCallback(async (): Promise<void> => {
    if (!output?.content) return;
    try {
      await Share.share({
        message: pageTitle
          ? `${pageTitle}\n\n${output.content}`
          : output.content,
      });
    } catch (err) {
      // User cancellation is normal; only surface real errors.
      if (err instanceof Error && !/dismiss|cancel/i.test(err.message)) {
        Alert.alert("Share failed", err.message);
      }
    }
  }, [output, pageTitle]);

  if (outputQuery.isError && !output) {
    return (
      <PhoneSafeArea>
        <NavBar title="Output" onBack={() => safeBack()} />
        <EmptyState
          icon="close"
          title="Failed to load output"
          body={(outputQuery.error as Error | undefined)?.message}
          action={
            <Button kind="secondary" onPress={() => outputQuery.refetch()}>
              Retry
            </Button>
          }
        />
      </PhoneSafeArea>
    );
  }

  return (
    <PhoneSafeArea>
      <NavBar
        title={headerTitle}
        onBack={() => safeBack()}
        trailing={
          <>
            <NavIcon name="copy" onPress={onCopy} />
            <NavIcon name="share" onPress={onShare} />
          </>
        }
      />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 60 }}
      >
        {outputQuery.isLoading || !output ? (
          <Row align="center" gap={10} style={{ paddingVertical: 24 }}>
            <ActivityIndicator />
            <Text kind="body" color={tokens.ink2}>
              Loading output…
            </Text>
          </Row>
        ) : (
          <Stack gap={16}>
            {/* FROM JOB badge — keeps the user oriented when arriving via a
                deep-link push notification or the per-job outputs list. */}
            {job ? (
              <Pressable
                onPress={() => safeBack()}
                style={({ pressed }) => ({
                  opacity: pressed ? 0.7 : 1,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: tokens.line,
                  padding: 12,
                  gap: 6,
                  backgroundColor: tokens.surface,
                })}
              >
                <Text
                  kind="micro"
                  color={tokens.ink3}
                  style={{ textTransform: "uppercase", letterSpacing: 0.5 }}
                >
                  From job
                </Text>
                <Row gap={8} align="center">
                  <Icon name="clock" size={14} color={tokens.ink2} />
                  <Text kind="caption" color={tokens.ink}>
                    {job.name}
                  </Text>
                </Row>
              </Pressable>
            ) : null}

            {pageTitle ? <Text kind="h2">{pageTitle}</Text> : null}
            {body ? <MarkdownView text={body} /> : null}
          </Stack>
        )}
      </ScrollView>
    </PhoneSafeArea>
  );
}

/** "Today · 09:00" / "Yesterday · 09:00" / "Mon · 09:00" / "Apr 24 · 09:00". */
function formatNavTs(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  if (Number.isNaN(d.getTime())) return "Output";
  const now = new Date();
  const startOfDay = (x: Date): number =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round(
    (startOfDay(now) - startOfDay(d)) / (24 * 3_600_000),
  );
  let dayPart: string;
  if (dayDiff === 0) dayPart = "Today";
  else if (dayDiff === 1) dayPart = "Yesterday";
  else if (dayDiff < 7)
    dayPart = d.toLocaleDateString(undefined, { weekday: "short" });
  else
    dayPart = d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${dayPart} · ${time}`;
}
