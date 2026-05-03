/**
 * Provider keys hub — `(app)/(settings)/keys`.
 *
 * Source: design/screens-3.jsx::KeysScreen (lines 177-214).
 *
 * Lists every provider known to the gateway, grouped by status (Configured /
 * Not set). Each row navigates to the per-key editor at /keys/[envKey]. A
 * search box at the top filters by provider label or env-var name.
 */
import { useMemo, useState } from "react";
import { RefreshControl, ScrollView } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import {
  Input,
  ListGroup,
  ListRow,
  NavBar,
  PhoneSafeArea,
  SkeletonGroup,
  Stack,
  StatusPill,
  Text,
  EmptyState,
  Button,
} from "@/components/ui";
import { listProviderKeys, type ProviderKey } from "@/api/keys";
import { useThemeTokens } from "@/components/ui";

export default function KeysHubScreen() {
  const router = useRouter();
  const tokens = useThemeTokens();
  const [query, setQuery] = useState("");

  const keysQ = useQuery({
    queryKey: ["settings", "keys"],
    queryFn: listProviderKeys,
  });

  const { configured, unset } = useMemo(() => {
    // Defensive: if the API returns a wrapper object instead of an array
    // (shape drift, stale cached response from a previous bundle, etc.),
    // unwrap or default rather than crashing the whole settings stack.
    const raw: unknown = keysQ.data;
    let all: ProviderKey[] = [];
    if (Array.isArray(raw)) {
      all = raw as ProviderKey[];
    } else if (raw && typeof raw === "object") {
      const wrapped = (raw as { keys?: unknown }).keys;
      if (Array.isArray(wrapped)) all = wrapped as ProviderKey[];
    }
    const q = query.trim().toLowerCase();
    const visible = q
      ? all.filter(
          (k) =>
            k.label.toLowerCase().includes(q) ||
            k.envKey.toLowerCase().includes(q) ||
            k.providerId.toLowerCase().includes(q),
        )
      : all;
    return {
      configured: visible.filter((k) => k.status === "set"),
      unset: visible.filter((k) => k.status !== "set"),
    };
  }, [keysQ.data, query]);

  const navigateToEditor = (envKey: string) => {
    router.push(`/(settings)/keys/${encodeURIComponent(envKey)}`);
  };

  return (
    <PhoneSafeArea>
      <NavBar title="Provider keys" onBack={() => router.back()} />
      <Stack gap={10} style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
        <Input
          value={query}
          onChange={setQuery}
          icon="search"
          placeholder="Search providers"
        />
      </Stack>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 60 }}
        refreshControl={
          <RefreshControl
            refreshing={keysQ.isRefetching}
            onRefresh={() => keysQ.refetch()}
            tintColor={tokens.accent}
            colors={[tokens.accent]}
          />
        }
      >
        {keysQ.isError ? (
          <EmptyState
            icon="key"
            title="Couldn't load keys"
            body={
              keysQ.error instanceof Error
                ? keysQ.error.message
                : "Pull down to retry."
            }
            action={
              <Button kind="secondary" onClick={() => keysQ.refetch()}>
                Retry
              </Button>
            }
          />
        ) : null}
        {!keysQ.isError && keysQ.data && keysQ.data.length === 0 ? (
          <EmptyState
            icon="key"
            title="No providers"
            body="The gateway didn't return any provider definitions."
          />
        ) : null}
        {/* Skeleton on initial load — prevents the "all empty" flash. */}
        {keysQ.isLoading ? <SkeletonGroup count={6} /> : null}
        {/* All-unset case: show a friendly empty state instead of the blank
            "Not set" header users currently land on after first install. */}
        {!keysQ.isLoading &&
        !keysQ.isError &&
        configured.length === 0 &&
        unset.length > 0 &&
        query.trim().length === 0 ? (
          <EmptyState
            icon="key"
            title="No keys configured yet"
            body="Tap a provider below to paste an API key."
          />
        ) : null}
        <Stack gap={16}>
          {configured.length > 0 ? (
            <ListGroup header="Configured">
              {configured.map((k) => (
                <ListRow
                  key={k.envKey}
                  icon="key"
                  iconColor={tokens.positive + "26"}
                  title={k.label}
                  subtitle={k.envKey}
                  right={<StatusPill kind="online" label="set" />}
                  chevron
                  onPress={() => navigateToEditor(k.envKey)}
                />
              ))}
            </ListGroup>
          ) : null}
          {unset.length > 0 ? (
            <ListGroup header="Not set">
              {unset.map((k) => (
                <ListRow
                  key={k.envKey}
                  icon="key"
                  title={k.label}
                  subtitle={k.envKey}
                  right={<StatusPill kind="paused" label="unset" />}
                  chevron
                  onPress={() => navigateToEditor(k.envKey)}
                />
              ))}
            </ListGroup>
          ) : null}
          {!keysQ.isLoading &&
          configured.length === 0 &&
          unset.length === 0 &&
          query.trim().length > 0 ? (
            <Text
              kind="caption"
              className="text-ink-3"
              style={{ paddingHorizontal: 16, marginTop: 16, textAlign: "center" }}
            >
              No providers match "{query}".
            </Text>
          ) : null}
        </Stack>
      </ScrollView>
    </PhoneSafeArea>
  );
}
