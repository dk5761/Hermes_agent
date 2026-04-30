/**
 * Toolsets — Stage 4 (Tools & toolsets).
 *
 * Mirrors design/screens-3.jsx::ToolsScreen. Shows toolsets returned by
 * Hermes' /tools/toolsets, grouped by enabled/available. The enable Toggle
 * persists to AsyncStorage (`toolsets.prefs.<id>`) — the upstream endpoint
 * is read-only at the moment, so this is a local-only override that we'll
 * forward once the backend grows a write surface.
 *
 * Tapping a row shows a "Coming soon" alert; the detail screen is deferred.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, RefreshControl, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQuery } from "@tanstack/react-query";

import {
  Button,
  EmptyState,
  ListGroup,
  ListRow,
  NavBar,
  PhoneSafeArea,
  Row,
  Text,
  Toggle,
  useThemeTokens,
} from "@/components/ui";
import { getToolsets, type Toolset } from "@/api/toolsets";

const STORAGE_PREFIX = "toolsets.prefs.";

interface PrefsMap {
  [id: string]: boolean;
}

async function loadPrefs(ids: string[]): Promise<PrefsMap> {
  const keys = ids.map((id) => STORAGE_PREFIX + id);
  if (!keys.length) return {};
  try {
    const pairs = await AsyncStorage.multiGet(keys);
    const out: PrefsMap = {};
    for (const [k, v] of pairs) {
      if (v === null) continue;
      const id = k.slice(STORAGE_PREFIX.length);
      out[id] = v === "1";
    }
    return out;
  } catch {
    return {};
  }
}

async function setPref(id: string, on: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_PREFIX + id, on ? "1" : "0");
  } catch {
    // Persistence is best-effort; UI already reflects the new value.
  }
}

export default function ToolsetsScreen() {
  const router = useRouter();
  const tokens = useThemeTokens();

  const toolsetsQ = useQuery({
    queryKey: ["toolsets"],
    queryFn: getToolsets,
    staleTime: 30_000,
    retry: false,
  });

  // Local override map. Hydrated from AsyncStorage once toolsets arrive so we
  // know which keys to read.
  const [prefs, setPrefs] = useState<PrefsMap>({});

  useEffect(() => {
    const ids = toolsetsQ.data?.map((t) => t.id) ?? [];
    if (!ids.length) return;
    let cancelled = false;
    void loadPrefs(ids).then((p) => {
      if (!cancelled) setPrefs(p);
    });
    return () => {
      cancelled = true;
    };
  }, [toolsetsQ.data]);

  const isEnabled = useCallback(
    (t: Toolset): boolean => (prefs[t.id] ?? t.enabled) === true,
    [prefs],
  );

  const togglePref = useCallback((id: string, next: boolean) => {
    setPrefs((prev) => ({ ...prev, [id]: next }));
    void setPref(id, next);
  }, []);

  const onRowPress = useCallback(() => {
    Alert.alert("Coming soon", "Toolset detail screen isn't built yet.");
  }, []);

  const grouped = useMemo(() => {
    const list = toolsetsQ.data ?? [];
    const enabled: Toolset[] = [];
    const available: Toolset[] = [];
    for (const t of list) (isEnabled(t) ? enabled : available).push(t);
    return { enabled, available };
  }, [toolsetsQ.data, isEnabled]);

  const renderRow = useCallback(
    (t: Toolset) => {
      const on = isEnabled(t);
      const subtitle =
        t.toolCount > 0
          ? t.description
            ? `${t.toolCount} tools · ${t.description}`
            : `${t.toolCount} tools`
          : t.description;
      return (
        <ListRow
          key={t.id}
          icon="bolt"
          iconColor={on ? tokens.accentBg : undefined}
          title={t.name}
          subtitle={subtitle}
          right={
            <Row gap={8} align="center">
              {t.needsEnv ? (
                <Text
                  kind="micro"
                  mono
                  color={tokens.warning}
                  style={{
                    paddingHorizontal: 6,
                    paddingVertical: 2,
                    borderRadius: 4,
                    backgroundColor: tokens.warning + "22",
                  }}
                >
                  needs {t.needsEnv}
                </Text>
              ) : null}
              <Toggle on={on} onChange={(v) => togglePref(t.id, v)} />
            </Row>
          }
          onPress={onRowPress}
          chevron
        />
      );
    },
    [isEnabled, onRowPress, togglePref, tokens.accentBg, tokens.warning],
  );

  const isLoading = toolsetsQ.isLoading;
  const isError = toolsetsQ.isError;
  const list = toolsetsQ.data ?? [];

  return (
    <PhoneSafeArea>
      <NavBar title="Tools & toolsets" onBack={() => router.back()} />
      <ScrollView
        contentContainerStyle={{ paddingBottom: 60 }}
        refreshControl={
          <RefreshControl
            refreshing={toolsetsQ.isFetching && !toolsetsQ.isLoading}
            onRefresh={() => toolsetsQ.refetch()}
            tintColor={tokens.accent}
          />
        }
      >
        {isLoading ? (
          <View style={{ paddingVertical: 60, alignItems: "center" }}>
            <ActivityIndicator color={tokens.accent} />
          </View>
        ) : isError ? (
          <EmptyState
            icon="bolt"
            title="Failed to load toolsets"
            body={(toolsetsQ.error as Error)?.message ?? "Unknown error"}
            action={
              <Button kind="secondary" onClick={() => toolsetsQ.refetch()}>
                Retry
              </Button>
            }
          />
        ) : list.length === 0 ? (
          <EmptyState
            icon="bolt"
            title="No toolsets"
            body="Hermes hasn't registered any toolsets with the agent."
          />
        ) : (
          <View style={{ gap: 18, paddingTop: 8 }}>
            {grouped.enabled.length > 0 ? (
              <ListGroup header="Enabled">
                {grouped.enabled.map(renderRow)}
              </ListGroup>
            ) : null}
            {grouped.available.length > 0 ? (
              <ListGroup header="Available">
                {grouped.available.map(renderRow)}
              </ListGroup>
            ) : null}
          </View>
        )}
      </ScrollView>
    </PhoneSafeArea>
  );
}
