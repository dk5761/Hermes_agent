/**
 * Settings hub — Stage 4 redesign.
 *
 * Mirrors design/screens-3.jsx::SettingsIndex. Identity card + four ListGroups
 * (Models / Workspace / Account / sign-out) + footer build string.
 *
 * Each row's `detail` is sourced from a small TanStack Query — failures fall
 * through silently because the index must always render.
 */
import { useCallback, useMemo } from "react";
import { ScrollView, View } from "react-native";
import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";

import {
  HermesMark,
  ListGroup,
  ListRow,
  NavBar,
  PhoneSafeArea,
  Row,
  Stack,
  Text,
  useThemeTokens,
} from "@/components/ui";
import { useAuthStore } from "@/auth/store";
import { logout as apiLogout } from "@/api/auth";
import { API_URL } from "@/config";
import {
  getAuxConfig,
  getKeysSummary,
  getMainModel,
  getStorageUsage,
} from "@/api/settings";
import { useNotificationsInbox } from "@/state/notifications-inbox";
import { useVoiceSettings } from "@/state/voice-settings";
import { OfflineBanner } from "@/components/OfflineBanner";

function formatBytes(n: number): string {
  if (!n) return "—";
  const KB = 1024,
    MB = KB * 1024,
    GB = MB * 1024;
  if (n >= GB) return `${(n / GB).toFixed(1)} GB`;
  if (n >= MB) return `${(n / MB).toFixed(0)} MB`;
  if (n >= KB) return `${(n / KB).toFixed(0)} KB`;
  return `${n} B`;
}

function hostFromUrl(url: string): string {
  // strip protocol; keep host:port + path tail. Best-effort, works without URL polyfill.
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

function initials(username: string | null | undefined): string {
  if (!username) return "?";
  const trimmed = username.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/[\s@.\-_]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return trimmed.slice(0, 2).toUpperCase();
}

export default function SettingsIndexScreen() {
  const router = useRouter();
  const tokens = useThemeTokens();

  const username = useAuthStore((s) => s.user?.username);
  const refreshToken = useAuthStore((s) => s.refreshToken);
  const clear = useAuthStore((s) => s.clear);

  const version = Constants.expoConfig?.version ?? "0.0.0";

  // Data sources for `detail` slots. Fail-soft: if any query errors, the
  // row simply omits its detail; nothing breaks.
  const mainModelQ = useQuery({
    queryKey: ["settings", "model"],
    queryFn: getMainModel,
    staleTime: 30_000,
    retry: false,
  });
  const visionQ = useQuery({
    queryKey: ["settings", "aux", "vision"],
    queryFn: () => getAuxConfig("vision"),
    staleTime: 30_000,
    retry: false,
  });
  const keysQ = useQuery({
    queryKey: ["settings", "keys"],
    queryFn: getKeysSummary,
    staleTime: 30_000,
    retry: false,
  });
  const storageQ = useQuery({
    queryKey: ["storage", "usage"],
    queryFn: getStorageUsage,
    staleTime: 30_000,
    retry: false,
  });
  const inboxUnread = useNotificationsInbox(
    (s) => s.items.filter((it) => !it.archived && !it.read).length,
  );

  const voiceEnabled = useVoiceSettings((s) => s.enabled);

  const voiceDetail = voiceEnabled ? "Tap or hold" : "Off";

  const onLogout = useCallback(async () => {
    if (refreshToken) await apiLogout(refreshToken);
    await clear();
    router.replace("/login");
  }, [clear, refreshToken, router]);

  const goto = useCallback(
    (path: string) => () => {
      router.push(path as never);
    },
    [router],
  );

  const visionDetail = useMemo(() => {
    if (!visionQ.data) return undefined;
    const provider = visionQ.data.provider || "auto";
    return provider;
  }, [visionQ.data]);

  const keysDetail = useMemo(() => {
    if (!keysQ.data) return undefined;
    return `${keysQ.data.set} set · ${keysQ.data.unset} unset`;
  }, [keysQ.data]);

  const storageDetail = useMemo(() => {
    if (!storageQ.data) return undefined;
    if (!storageQ.data.totalBytes) return undefined;
    return formatBytes(storageQ.data.totalBytes);
  }, [storageQ.data]);

  const serverHost = useMemo(() => hostFromUrl(API_URL), []);

  return (
    <PhoneSafeArea>
      <NavBar large title="Settings" />
      <OfflineBanner />
      {/* paddingBottom must clear the floating AppTabBar (~50pt bar + safe area). */}
      <ScrollView contentContainerStyle={{ paddingBottom: 140 }}>
        <Stack gap={20}>
          {/* Identity */}
          <View
            className="bg-surface border border-line"
            style={{
              marginHorizontal: 16,
              padding: 14,
              borderRadius: 14,
            }}
          >
            <Row gap={12} align="center">
              <View
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 22,
                  backgroundColor: tokens.accentBg,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text
                  kind="body-lg"
                  color={tokens.accent}
                  style={{ fontWeight: "600" }}
                >
                  {initials(username)}
                </Text>
              </View>
              <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
                <Text kind="body-lg" style={{ fontWeight: "600" }} numberOfLines={1}>
                  {username ?? "(unknown)"}
                </Text>
                <Text kind="caption" mono className="text-ink-3" numberOfLines={1}>
                  {serverHost} · v{version}
                </Text>
              </Stack>
            </Row>
          </View>

          <ListGroup header="Models">
            <ListRow
              icon="spark"
              iconColor={tokens.accentBg}
              title="Main model"
              detail={mainModelQ.data?.model}
              chevron
              onPress={goto("/(settings)/model")}
            />
            <ListRow
              icon="image"
              title="Vision"
              detail={visionDetail}
              chevron
              onPress={goto("/(settings)/vision")}
            />
            <ListRow
              icon="flow"
              title="Other auxiliary models"
              chevron
              onPress={goto("/(settings)/aux")}
            />
            <ListRow
              icon="key"
              title="Provider API keys"
              detail={keysDetail}
              chevron
              onPress={goto("/(settings)/keys")}
            />
          </ListGroup>

          <ListGroup header="Workspace">
            <ListRow
              icon="bolt"
              title="Tools & toolsets"
              chevron
              onPress={goto("/(settings)/toolsets")}
            />
            <ListRow
              icon="hash"
              title="Skills"
              chevron
              onPress={goto("/(settings)/skills")}
            />
            <ListRow
              icon="bell"
              title="Notifications"
              chevron
              onPress={goto("/(settings)/notifications")}
            />
            <ListRow
              icon="shieldCheck"
              title="Approval policy"
              chevron
              onPress={goto("/(settings)/approvals")}
            />
            <ListRow
              icon="bell"
              title="Notifications inbox"
              detail={inboxUnread > 0 ? `${inboxUnread} unread` : undefined}
              chevron
              onPress={goto("/(settings)/notifications-inbox")}
            />
            <ListRow
              icon="database"
              title="Storage"
              detail={storageDetail}
              chevron
              onPress={goto("/(settings)/storage")}
            />
            <ListRow
              icon="mic"
              title="Voice input"
              detail={voiceDetail}
              chevron
              onPress={goto("/(settings)/voice")}
            />
          </ListGroup>

          <ListGroup header="Account">
            <ListRow
              icon="shieldCheck"
              title="Account & security"
              chevron
              onPress={goto("/(settings)/account")}
            />
            <ListRow
              icon="terminal"
              title="Logs & diagnostics"
              chevron
              onPress={goto("/(settings)/diagnostics")}
            />
            <ListRow
              icon="bolt"
              title="Usage & costs"
              chevron
              onPress={goto("/(settings)/usage")}
            />
            <ListRow
              icon="cog"
              title="Appearance"
              chevron
              onPress={goto("/(settings)/appearance")}
            />
            <ListRow
              icon="cog"
              title="App updates"
              chevron
              onPress={goto("/(settings)/updates")}
            />
            <ListRow
              icon="doc"
              title="About"
              chevron
              onPress={goto("/(settings)/about")}
            />
          </ListGroup>

          <ListGroup>
            <ListRow
              icon="chevR"
              iconColor={tokens.danger + "22"}
              title="Sign out"
              danger
              onPress={onLogout}
            />
          </ListGroup>

          <Stack align="center" style={{ paddingHorizontal: 16, paddingTop: 4 }}>
            <Text kind="caption" className="text-ink-3">
              Hermes Mobile · v{version}
            </Text>
          </Stack>

          {__DEV__ ? (
            <Stack gap={8} style={{ paddingHorizontal: 16, paddingTop: 16 }}>
              <Text kind="micro" className="text-ink-3 uppercase">
                Dev
              </Text>
              <ListGroup>
                <ListRow
                  icon="cog"
                  title="Theme debug"
                  chevron
                  onPress={goto("/__theme")}
                />
                <ListRow
                  icon="cog"
                  title="Components debug"
                  chevron
                  onPress={goto("/__components")}
                />
              </ListGroup>
              {/* Tiny visual hint that we rendered the mark cleanly. */}
              <Row align="center" justify="center" style={{ paddingTop: 12 }}>
                <HermesMark size={18} />
              </Row>
            </Stack>
          ) : null}
        </Stack>
      </ScrollView>
    </PhoneSafeArea>
  );
}
