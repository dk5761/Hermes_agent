/**
 * Storage settings — `(app)/(settings)/storage`.
 *
 * Source: design/screens-3.jsx::StorageScreen (lines 407-468).
 *
 * Reads `/storage/usage` and renders a hero total + per-kind / per-table
 * breakdowns. Cleanup buttons are deferred until the backend ships those
 * endpoints (Phase 8).
 */
import { useMemo } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import {
  Button,
  EmptyState,
  ListGroup,
  ListRow,
  NavBar,
  PhoneSafeArea,
  ProgressBar,
  Row,
  Stack,
  Text,
  useThemeTokens,
} from "@/components/ui";
import {
  getStorageUsage,
  type BlobKind,
  type StorageUsage,
} from "@/api/storage";
import { formatBytes } from "@/util/bytes";

// 5 GB target — matches design intent (a "sensible cap" for the hero progress).
const STORAGE_HEADROOM_BYTES = 5 * 1024 * 1024 * 1024;

const BLOB_KIND_META: Record<
  BlobKind,
  { label: string; icon: "image" | "doc" | "archive" | "database" }
> = {
  image: { label: "Images", icon: "image" },
  pdf: { label: "PDFs", icon: "doc" },
  file: { label: "Files", icon: "archive" },
  derived: { label: "Derived", icon: "database" },
};

function blobKindOrder(): BlobKind[] {
  return ["image", "pdf", "file", "derived"];
}

export default function StorageScreen() {
  const router = useRouter();
  const tokens = useThemeTokens();

  const usageQ = useQuery({
    queryKey: ["storage", "usage"],
    queryFn: getStorageUsage,
  });

  const totals = useMemo(() => totalsFor(usageQ.data), [usageQ.data]);

  return (
    <PhoneSafeArea>
      <NavBar title="Storage" onBack={() => router.back()} />
      <ScrollView
        contentContainerStyle={{ paddingBottom: 60 }}
        refreshControl={
          <RefreshControl
            refreshing={usageQ.isRefetching}
            onRefresh={() => usageQ.refetch()}
            tintColor={tokens.accent}
            colors={[tokens.accent]}
          />
        }
      >
        {usageQ.isLoading ? (
          <View style={{ paddingVertical: 60, alignItems: "center" }}>
            <ActivityIndicator color={tokens.accent} />
          </View>
        ) : null}

        {usageQ.isError ? (
          <EmptyState
            icon="database"
            title="Couldn't load storage usage"
            body={
              usageQ.error instanceof Error
                ? usageQ.error.message
                : "Pull down to retry."
            }
            action={
              <Button kind="secondary" onClick={() => usageQ.refetch()}>
                Retry
              </Button>
            }
          />
        ) : null}

        {usageQ.data ? (
          <Stack gap={16} style={{ paddingTop: 12 }}>
            {/* Hero — total bytes used + headroom progress. */}
            <View
              className="bg-surface border border-line"
              style={{ marginHorizontal: 16, padding: 16, borderRadius: 14 }}
            >
              <Stack gap={10}>
                <Row align="baseline" justify="space-between">
                  <Text kind="micro" className="text-ink-3 uppercase">
                    Total used
                  </Text>
                  <Text kind="h2" mono>
                    {formatBytes(totals.totalBytes)}
                  </Text>
                </Row>
                <ProgressBar
                  value={Math.min(1, totals.totalBytes / STORAGE_HEADROOM_BYTES)}
                />
                <Text kind="caption" className="text-ink-3">
                  Across DB, blobs, and cache · headroom{" "}
                  {formatBytes(STORAGE_HEADROOM_BYTES)}
                </Text>
              </Stack>
            </View>

            {/* Blob breakdown by kind. */}
            <ListGroup header="By kind">
              {blobKindOrder().map((kind) => {
                const meta = BLOB_KIND_META[kind];
                const bytes = usageQ.data.blobs.byKind[kind] ?? 0;
                const totalBlobs = usageQ.data.blobs.totalBytes || 1;
                const share = totalBlobs > 0 ? bytes / totalBlobs : 0;
                return (
                  <View key={kind} style={{ paddingVertical: 10 }}>
                    <ListRow
                      icon={meta.icon}
                      title={meta.label}
                      detail={formatBytes(bytes)}
                      chevron={false}
                    />
                    <View
                      style={{
                        paddingHorizontal: 16,
                        paddingTop: 4,
                        paddingBottom: 6,
                      }}
                    >
                      <ProgressBar value={share} color={tokens.ink2} />
                    </View>
                  </View>
                );
              })}
            </ListGroup>

            {/* Database — totals + per-table rows. */}
            <ListGroup
              header="Database"
              footer={usageQ.data.gatewayDb.path}
            >
              <ListRow
                icon="database"
                title="Gateway DB"
                detail={formatBytes(usageQ.data.gatewayDb.bytes)}
                chevron={false}
              />
              {usageQ.data.gatewayDb.tables.map((t) => (
                <ListRow
                  key={t.name}
                  title={t.name}
                  subtitle={`${t.rows.toLocaleString()} rows`}
                  detail={formatBytes(t.bytes)}
                  chevron={false}
                />
              ))}
            </ListGroup>

            {/* Materialize cache — only if backend reports it. */}
            {usageQ.data.materializeCache ? (
              <ListGroup
                header="Materialize cache"
                footer={usageQ.data.materializeCache.root}
              >
                <ListRow
                  icon="archive"
                  title="Cache size"
                  subtitle={`${usageQ.data.materializeCache.files.toLocaleString()} files`}
                  detail={formatBytes(usageQ.data.materializeCache.bytes)}
                  chevron={false}
                />
                <View style={{ paddingHorizontal: 16, paddingVertical: 10 }}>
                  <Button
                    kind="secondary"
                    size="sm"
                    leftIcon="trash"
                    disabled
                    onClick={() => {}}
                  >
                    Clear cache (coming soon)
                  </Button>
                </View>
              </ListGroup>
            ) : null}

            {/* Local-only blob ops. Cleanup deferred until backend exposes it. */}
            {usageQ.data.blobs.provider === "local" ? (
              <ListGroup
                header="Local blobs"
                footer={usageQ.data.blobs.root}
              >
                <ListRow
                  icon="archive"
                  title="Stored objects"
                  subtitle={usageQ.data.blobs.provider}
                  detail={usageQ.data.blobs.objectCount.toLocaleString()}
                  chevron={false}
                />
                <View style={{ paddingHorizontal: 16, paddingVertical: 10 }}>
                  <Button
                    kind="secondary"
                    size="sm"
                    leftIcon="refresh"
                    disabled
                    onClick={() => {}}
                  >
                    Run cleanup now (coming soon)
                  </Button>
                </View>
              </ListGroup>
            ) : null}
          </Stack>
        ) : null}
      </ScrollView>
    </PhoneSafeArea>
  );
}

function totalsFor(usage: StorageUsage | undefined): { totalBytes: number } {
  if (!usage) return { totalBytes: 0 };
  const cache = usage.materializeCache?.bytes ?? 0;
  return {
    totalBytes:
      (usage.gatewayDb?.bytes ?? 0) + (usage.blobs?.totalBytes ?? 0) + cache,
  };
}
