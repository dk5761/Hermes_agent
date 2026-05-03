/**
 * Notifications settings — `(app)/(settings)/notifications`.
 *
 * Source: design/screens-3.jsx::NotificationsScreen (lines 356-406).
 *
 * Local-only preferences (persisted to AsyncStorage under `notifications.prefs.*`)
 * for which Expo notification kinds the app should display, plus a permission
 * status card that links out to system settings when denied. The active push
 * token (read from SecureStore) is shown so users can confirm registration.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Linking, Platform, RefreshControl, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getUserPrefs, updateUserPrefs, type UserPrefs } from "@/api/prefs";
import {
  Button,
  Field,
  Input,
  ListGroup,
  ListRow,
  NavBar,
  PhoneSafeArea,
  Row,
  Section,
  Stack,
  StatusPill,
  Text,
  Toggle,
  showToast,
  useThemeTokens,
} from "@/components/ui";
import { secureStorage } from "@/auth/secure-storage";
import { sendTestPushNotification, unregisterPushToken } from "@/api/devices";

type PrefKey = "cron" | "approval" | "serverError" | "quietHoursEnabled";

interface NotificationPrefs {
  cron: boolean;
  approval: boolean;
  serverError: boolean;
  quietHoursEnabled: boolean;
  quietFrom: string;
  quietTo: string;
}

const PREFS_PREFIX = "notifications.prefs.";
const DEFAULT_PREFS: NotificationPrefs = {
  cron: true,
  approval: true,
  serverError: true,
  quietHoursEnabled: false,
  quietFrom: "22:00",
  quietTo: "07:00",
};

const PREF_KEYS: ReadonlyArray<keyof NotificationPrefs> = [
  "cron",
  "approval",
  "serverError",
  "quietHoursEnabled",
  "quietFrom",
  "quietTo",
];

async function loadPrefs(): Promise<NotificationPrefs> {
  const result: NotificationPrefs = { ...DEFAULT_PREFS };
  await Promise.all(
    PREF_KEYS.map(async (k) => {
      const raw = await AsyncStorage.getItem(PREFS_PREFIX + k);
      if (raw === null) return;
      if (k === "quietFrom" || k === "quietTo") {
        result[k] = raw;
      } else {
        result[k] = raw === "1";
      }
    }),
  );
  return result;
}

async function savePref(
  key: keyof NotificationPrefs,
  value: boolean | string,
): Promise<void> {
  if (typeof value === "boolean") {
    await AsyncStorage.setItem(PREFS_PREFIX + key, value ? "1" : "0");
  } else {
    await AsyncStorage.setItem(PREFS_PREFIX + key, value);
  }
}

interface PermissionState {
  status: "granted" | "denied" | "undetermined" | "unsupported";
  canAskAgain: boolean;
}

async function readPermission(): Promise<PermissionState> {
  if (Platform.OS === "web") {
    return { status: "unsupported", canAskAgain: false };
  }
  const res = await Notifications.getPermissionsAsync();
  let status: PermissionState["status"];
  if (
    res.granted ||
    res.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL
  ) {
    status = "granted";
  } else if (res.canAskAgain) {
    status = "undetermined";
  } else {
    status = "denied";
  }
  return { status, canAskAgain: res.canAskAgain };
}

export default function NotificationsScreen() {
  const router = useRouter();
  const tokens = useThemeTokens();
  const queryClient = useQueryClient();

  const [prefs, setPrefs] = useState<NotificationPrefs>(DEFAULT_PREFS);
  const [permission, setPermission] = useState<PermissionState | null>(null);
  const [pushToken, setPushToken] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // ─── server-backed chat-complete pref ─────────────────────────────────────
  const prefsQuery = useQuery({ queryKey: ["user-prefs"], queryFn: getUserPrefs });
  const setPrefMut = useMutation({
    mutationFn: (next: boolean) => updateUserPrefs({ notifyChatComplete: next }),
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey: ["user-prefs"] });
      const prev = queryClient.getQueryData<UserPrefs>(["user-prefs"]);
      queryClient.setQueryData<UserPrefs>(["user-prefs"], { notifyChatComplete: next });
      return { prev };
    },
    onError: (_err, _next, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(["user-prefs"], ctx.prev);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["user-prefs"] }),
  });
  // While loading, fall back to true (the server default) so the toggle
  // renders in an enabled state rather than flickering to false then back.
  const chatCompleteEnabled = prefsQuery.data?.notifyChatComplete ?? true;

  // ─── test push fan-out ────────────────────────────────────────────────────
  // Verifies end-to-end push delivery: token registered, APNs reachable,
  // banner permission granted. Backend fans out to every device the current
  // user has registered.
  const testPushMut = useMutation({
    mutationFn: sendTestPushNotification,
    onSuccess: (res) => {
      if (res.sent === 0) {
        showToast(
          res.devices === 0
            ? "No devices registered"
            : `${res.errors} device${res.errors === 1 ? "" : "s"} failed`,
          "error",
        );
      } else {
        showToast(
          `Test sent to ${res.sent} device${res.sent === 1 ? "" : "s"}`,
          "success",
        );
      }
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Send failed";
      showToast(msg, "error");
    },
    meta: { silent: true },
  });

  const refresh = useCallback(async () => {
    const [next, perm, token] = await Promise.all([
      loadPrefs(),
      readPermission(),
      secureStorage.get("pushToken"),
    ]);
    setPrefs(next);
    setPermission(perm);
    setPushToken(token);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onPullRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  const updateBool = (key: PrefKey) => (next: boolean) => {
    setPrefs((p) => ({ ...p, [key]: next }));
    void savePref(key, next);
  };

  const onRevokeToken = () => {
    if (!pushToken) return;
    Alert.alert(
      "Remove push token?",
      "This device will stop receiving notifications until the app re-registers.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            await unregisterPushToken(pushToken);
            await secureStorage.del("pushToken");
            setPushToken(null);
          },
        },
      ],
    );
  };

  const permissionPill = useMemo(() => {
    if (!permission) return null;
    switch (permission.status) {
      case "granted":
        return <StatusPill kind="online" label="allowed" />;
      case "denied":
        return <StatusPill kind="offline" label="blocked" />;
      case "undetermined":
        return <StatusPill kind="connecting" label="not asked" />;
      case "unsupported":
        return <StatusPill kind="paused" label="n/a" />;
    }
  }, [permission]);

  return (
    <PhoneSafeArea>
      <NavBar title="Notifications" onBack={() => router.back()} />
      <ScrollView
        contentContainerStyle={{ paddingBottom: 60 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onPullRefresh}
            tintColor={tokens.accent}
            colors={[tokens.accent]}
          />
        }
      >
        <Stack gap={18}>
          {/* Permission card. */}
          <View
            className="bg-surface border border-line"
            style={{ marginHorizontal: 16, padding: 14, borderRadius: 12 }}
          >
            <Row gap={10} align="center">
              <Stack gap={2} style={{ flex: 1 }}>
                <Text kind="label">System permission</Text>
                <Text kind="caption" className="text-ink-3">
                  {permission?.status === "granted"
                    ? "Push, sound, and badges are allowed."
                    : permission?.status === "denied"
                      ? "Push is blocked. Enable in iOS/Android settings."
                      : permission?.status === "undetermined"
                        ? "Permission has not been requested yet."
                        : "Push notifications aren't supported on this platform."}
                </Text>
              </Stack>
              {permissionPill}
            </Row>
            {permission?.status === "denied" ? (
              <Stack gap={0} style={{ marginTop: 10 }}>
                <Button
                  kind="secondary"
                  size="sm"
                  leftIcon="cog"
                  onClick={() => Linking.openSettings()}
                >
                  Open system settings
                </Button>
              </Stack>
            ) : null}
          </View>

          {/* Per-kind toggles. */}
          <ListGroup header="Categories">
            <ListRow
              icon="bell"
              title="Notify when chat finishes"
              subtitle="Get a notification when Hermes is done thinking. Useful for long runs you walk away from."
              right={
                <Toggle
                  on={chatCompleteEnabled}
                  onChange={(next) => setPrefMut.mutate(next)}
                />
              }
            />
            <ListRow
              icon="clock"
              title="Cron completion"
              subtitle="When a scheduled job finishes"
              right={<Toggle on={prefs.cron} onChange={updateBool("cron")} />}
            />
            <ListRow
              icon="shield"
              iconColor={tokens.warning + "33"}
              title="Approval requests"
              subtitle="When Hermes is blocked on you"
              right={
                <Toggle on={prefs.approval} onChange={updateBool("approval")} />
              }
            />
            <ListRow
              icon="bolt"
              title="Server errors"
              subtitle="Gateway / Hermes-side failures"
              right={
                <Toggle
                  on={prefs.serverError}
                  onChange={updateBool("serverError")}
                />
              }
            />
          </ListGroup>

          {/* Diagnostic: send a push to every registered device. Confirms
              token registration + APNs delivery + iOS notification permission
              all line up. Useful right after first install. */}
          <ListGroup
            header="Diagnostics"
            footer="Sends a test notification to every device signed in to this account."
          >
            <ListRow
              icon="bell"
              title="Send test notification"
              subtitle={
                testPushMut.isPending ? "Sending…" : "Verify push delivery"
              }
              onPress={() => {
                if (testPushMut.isPending) return;
                testPushMut.mutate();
              }}
            />
          </ListGroup>

          {/* Quiet hours — local prefs only, no server enforcement yet. */}
          <ListGroup
            header="Quiet hours"
            footer="Stored locally on this device. Times are 24-hour HH:MM."
          >
            <ListRow
              title="Enable quiet hours"
              right={
                <Toggle
                  on={prefs.quietHoursEnabled}
                  onChange={updateBool("quietHoursEnabled")}
                />
              }
              chevron={false}
            />
            <View
              style={{ paddingHorizontal: 16, paddingVertical: 10, gap: 10 }}
            >
              <Field label="From">
                <Input
                  value={prefs.quietFrom}
                  onChange={(t) => {
                    setPrefs((p) => ({ ...p, quietFrom: t }));
                    void savePref("quietFrom", t);
                  }}
                  mono
                  placeholder="22:00"
                />
              </Field>
              <Field label="To">
                <Input
                  value={prefs.quietTo}
                  onChange={(t) => {
                    setPrefs((p) => ({ ...p, quietTo: t }));
                    void savePref("quietTo", t);
                  }}
                  mono
                  placeholder="07:00"
                />
              </Field>
            </View>
          </ListGroup>

          {/* Devices — show the locally-stored token (one per install). */}
          <ListGroup
            header="Devices"
            footer={
              pushToken
                ? "Token registered with the gateway."
                : "No active push token. Re-grant permission to register."
            }
          >
            {pushToken ? (
              <ListRow
                icon="key"
                iconColor={tokens.accentBg}
                title="This device"
                subtitle={`…${pushToken.slice(-8)}`}
                right={
                  <Button
                    kind="danger"
                    size="sm"
                    onClick={onRevokeToken}
                  >
                    Revoke
                  </Button>
                }
                chevron={false}
              />
            ) : (
              <ListRow
                title="No registered token"
                subtitle="Push token will appear after the next sign-in."
                chevron={false}
              />
            )}
          </ListGroup>

          {/* Defer test push — backend endpoint not yet available. */}
          <Section title="Test">
            <Stack gap={8} style={{ paddingHorizontal: 16 }}>
              <Button
                kind="secondary"
                leftIcon="bell"
                disabled
                onClick={() => {}}
              >
                Send test notification (coming soon)
              </Button>
            </Stack>
          </Section>
        </Stack>
      </ScrollView>
    </PhoneSafeArea>
  );
}
