/**
 * Cron output viewer — Stage 7 redesign.
 *
 * Visual target: design/screens-2.jsx::CronOutput (lines 151-188).
 *
 * Renders a single cron output as Markdown using the shared MarkdownView
 * component. The "Re-run with this output as context" button is a
 * placeholder — backend doesn't yet expose that endpoint, so we surface
 * a clear "Coming soon" alert rather than ship a dead control.
 */
import { useCallback, useEffect } from "react";
import { Alert, RefreshControl, ScrollView, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { safeBack } from "@/util/nav";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useNotificationsInbox } from "@/state/notifications-inbox";

import {
  Button,
  EmptyState,
  MarkdownView,
  NavBar,
  PhoneSafeArea,
  Row,
  Stack,
  Text,
  useThemeTokens,
} from "@/components/ui";
import { cronKeys, getOutput, triggerJob } from "@/api/cron";
import { formatRelative, toDate } from "@/util/time";

export default function CronOutputDetailScreen() {
  const queryClient = useQueryClient();
  const tokens = useThemeTokens();
  const params = useLocalSearchParams<{ jobId: string; outputId: string }>();
  const jobId = params.jobId ?? "";
  const outputId = params.outputId ?? "";

  const outputQuery = useQuery({
    queryKey: cronKeys.output(jobId, outputId),
    queryFn: () => getOutput(jobId, outputId),
    enabled: jobId.length > 0 && outputId.length > 0,
  });

  // Clear the unread badge on the cron tab when the user lands on the
  // detail page — covers in-app navigation as well as push-tap entry.
  useEffect(() => {
    if (!outputId) return;
    useNotificationsInbox.getState().markCronOutputRead(outputId);
  }, [outputId]);

  const reRunMut = useMutation({
    mutationFn: () => triggerJob(jobId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: cronKeys.outputs(jobId) });
      void queryClient.invalidateQueries({ queryKey: cronKeys.jobs() });
      void queryClient.invalidateQueries({ queryKey: cronKeys.job(jobId) });
    },
  });

  const onReRun = useCallback(() => {
    reRunMut.mutate();
  }, [reRunMut]);

  const onReRunWithContext = useCallback(() => {
    Alert.alert(
      "Coming soon",
      "Re-running with this output as context isn't supported yet.",
    );
  }, []);

  const data = outputQuery.data;
  const created = data ? toDate(data.createdAt) : null;
  const subtitle =
    created && data ? formatRelative(data.createdAt) : "Output";

  if (!data) {
    return (
      <PhoneSafeArea>
        <NavBar title="Output" onBack={() => safeBack(jobId ? `/(cron)/${jobId}` : "/(cron)")} />
        {outputQuery.isError ? (
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
        ) : null}
      </PhoneSafeArea>
    );
  }

  return (
    <PhoneSafeArea>
      <NavBar
        title="Output"
        subtitle={subtitle}
        onBack={() => safeBack(jobId ? `/(cron)/${jobId}` : "/(cron)")}
        trailing={
          <Button
            size="sm"
            kind="ghost"
            onPress={onReRun}
            disabled={reRunMut.isPending}
          >
            {reRunMut.isPending ? "Running…" : "Re-run"}
          </Button>
        }
      />
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 8,
          paddingBottom: 60,
        }}
        refreshControl={
          <RefreshControl
            refreshing={outputQuery.isFetching}
            onRefresh={() => outputQuery.refetch()}
            tintColor={tokens.accent}
            colors={[tokens.accent]}
          />
        }
      >
        <Stack gap={12}>
          {/* Top metadata strip — timestamp + length. Mirrors the design's
              compact "From job" card minus the job-name line, which would
              be redundant here (the user just navigated from the job). */}
          <Row gap={8} align="center" justify="space-between">
            <Text kind="caption" mono color={tokens.ink3}>
              {created ? created.toLocaleString() : "(unknown time)"}
            </Text>
            <Text kind="caption" mono color={tokens.ink3}>
              {data.content.length.toLocaleString()} chars
            </Text>
          </Row>
          <View
            style={{
              backgroundColor: tokens.surface,
              borderRadius: 14,
              borderWidth: 1,
              borderColor: tokens.line,
              padding: 14,
            }}
          >
            <MarkdownView text={data.content} />
          </View>
          <Button
            kind="secondary"
            full
            leftIcon="refresh"
            onPress={onReRunWithContext}
          >
            Re-run with this output as context
          </Button>
        </Stack>
      </ScrollView>
    </PhoneSafeArea>
  );
}
