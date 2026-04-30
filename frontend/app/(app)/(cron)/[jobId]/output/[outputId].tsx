import { useCallback } from "react";
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Screen } from "@/components/Screen";
import { Spinner } from "@/components/Spinner";
import { Button } from "@/components/Button";
import { Markdown } from "@/components/Markdown";
import { cronKeys, getOutput } from "@/api/cron";
import { BORDER, MUTED, PANEL, TEXT } from "@/config";
import { toDate } from "@/util/time";

export default function CronOutputDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ jobId: string; outputId: string }>();
  const jobId = params.jobId ?? "";
  const outputId = params.outputId ?? "";

  const outputQuery = useQuery({
    queryKey: cronKeys.output(jobId, outputId),
    queryFn: () => getOutput(jobId, outputId),
    enabled: jobId.length > 0 && outputId.length > 0,
  });

  const onOpenJob = useCallback(() => {
    router.push({ pathname: "/(cron)/[jobId]", params: { jobId } });
  }, [jobId, router]);

  const created = outputQuery.data ? toDate(outputQuery.data.createdAt) : null;

  return (
    <Screen flat>
      <Stack.Screen options={{ title: "Output" }} />
      {outputQuery.isLoading ? (
        <Spinner />
      ) : outputQuery.isError || !outputQuery.data ? (
        <View style={styles.errorWrap}>
          <Text style={styles.error}>Failed to load output.</Text>
          <Button label="Retry" onPress={() => outputQuery.refetch()} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.scroll}
          refreshControl={
            <RefreshControl
              refreshing={outputQuery.isFetching}
              onRefresh={() => outputQuery.refetch()}
              tintColor={MUTED}
            />
          }
        >
          <View style={styles.topBar}>
            <View style={styles.topMeta}>
              <Text style={styles.metaLabel}>generated</Text>
              <Text style={styles.metaValue}>
                {created ? created.toLocaleString() : "(unknown)"}
              </Text>
            </View>
            <Button label="Open job" variant="secondary" compact onPress={onOpenJob} />
          </View>
          <View style={styles.body}>
            <Markdown content={outputQuery.data.content} />
          </View>
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 16, paddingBottom: 32, gap: 12 },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: PANEL,
    borderColor: BORDER,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    gap: 12,
  },
  topMeta: { flex: 1 },
  metaLabel: {
    color: MUTED,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  metaValue: { color: TEXT, fontSize: 14 },
  body: {
    backgroundColor: PANEL,
    borderColor: BORDER,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
  },
  errorWrap: { padding: 16, gap: 12 },
  error: { color: "#FCA5A5", fontSize: 14 },
});
