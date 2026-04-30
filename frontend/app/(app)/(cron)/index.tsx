import { useCallback } from "react";
import {
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Screen } from "@/components/Screen";
import { Spinner } from "@/components/Spinner";
import { Button } from "@/components/Button";
import { CronJobRow } from "@/components/CronJobRow";
import { cronKeys, listJobs } from "@/api/cron";
import type { CronJob } from "@/api/types";
import { MUTED, TEXT } from "@/config";

export default function CronListScreen() {
  const router = useRouter();
  const jobsQuery = useQuery({
    queryKey: cronKeys.jobs(),
    queryFn: listJobs,
  });

  const onPressJob = useCallback(
    (job: CronJob) => {
      router.push({ pathname: "/(cron)/[jobId]", params: { jobId: job.id } });
    },
    [router],
  );

  const renderItem = useCallback(
    ({ item }: { item: CronJob }) => (
      <CronJobRow job={item} onPress={onPressJob} />
    ),
    [onPressJob],
  );

  const keyExtractor = useCallback((j: CronJob) => j.id, []);

  return (
    <Screen flat>
      <Stack.Screen options={{ title: "Cron" }} />
      {jobsQuery.isLoading ? (
        <Spinner />
      ) : jobsQuery.isError ? (
        <View style={styles.errorWrap}>
          <Text style={styles.error}>Failed to load cron jobs.</Text>
          <Button label="Retry" onPress={() => jobsQuery.refetch()} />
        </View>
      ) : (
        <FlatList
          data={jobsQuery.data?.jobs ?? []}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          ItemSeparatorComponent={Separator}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Text style={styles.empty}>No scheduled jobs.</Text>
              <Text style={styles.emptyHint}>
                Create cron jobs from the Hermes desktop UI; they'll appear here.
              </Text>
            </View>
          }
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={jobsQuery.isFetching}
              onRefresh={() => jobsQuery.refetch()}
              tintColor={MUTED}
            />
          }
        />
      )}
    </Screen>
  );
}

function Separator() {
  return <View style={styles.sep} />;
}

const styles = StyleSheet.create({
  listContent: { paddingVertical: 8 },
  sep: { height: 0 },
  emptyWrap: { padding: 32, gap: 8, alignItems: "center" },
  empty: { color: TEXT, fontSize: 15, fontWeight: "600" },
  emptyHint: { color: MUTED, fontSize: 13, textAlign: "center" },
  errorWrap: { padding: 16, gap: 12 },
  error: { color: "#FCA5A5", fontSize: 14 },
});
