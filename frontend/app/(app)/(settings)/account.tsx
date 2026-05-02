/**
 * Account & security — `(app)/(settings)/account`.
 *
 * Source: design/screens-3.jsx::AccountScreen (lines 522-550).
 *
 * Surfaces the signed-in user, the gateway URL (read-only), a
 * change-password modal sheet, and a list of active refresh-token sessions
 * with revoke controls. "Sign out everywhere" calls the gateway's logout
 * (which cascades-revokes) and clears local secure-storage.
 */
import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  EmptyState,
  Field,
  Input,
  ListGroup,
  ListRow,
  NavBar,
  PhoneSafeArea,
  Row,
  Section,
  Sheet,
  Toggle,
  showToast,
  Stack,
  StatusPill,
  Text,
  useThemeTokens,
  type SheetHandle,
} from "@/components/ui";
import { authenticateBiometric, useAppLock } from "@/state/app-lock";
import {
  changePassword,
  listAuthSessions,
  revokeAuthSession,
  type AuthSession,
} from "@/api/account";
import { logout as apiLogout } from "@/api/auth";
import { useAuthStore } from "@/auth/store";
import { ApiError } from "@/api/types";
import { API_URL } from "@/config";
import { formatRelative, toDate } from "@/util/time";
import { clearPushTokenWithBackend } from "@/notifications/register";

const MIN_PASSWORD_LEN = 12;

function formatExpires(s: AuthSession): string {
  const d = toDate(s.expiresAt);
  if (!d) return "—";
  return d.toLocaleDateString();
}

export default function AccountScreen() {
  const router = useRouter();
  const tokens = useThemeTokens();
  const qc = useQueryClient();
  const sheetRef = useRef<SheetHandle>(null);

  const user = useAuthStore((s) => s.user);
  const refreshToken = useAuthStore((s) => s.refreshToken);
  const clearAuth = useAuthStore((s) => s.clear);

  const sessionsQ = useQuery({
    queryKey: ["auth", "sessions"],
    queryFn: listAuthSessions,
  });

  // Local error UI handles failure modes — silence the global toast.
  const revokeMut = useMutation({
    mutationFn: (id: string) => revokeAuthSession(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["auth", "sessions"] }),
    onError: (err: unknown) => {
      Alert.alert("Couldn't revoke", extractErrorMessage(err));
    },
    meta: { silent: true },
  });

  const onChangePasswordPress = useCallback(() => {
    sheetRef.current?.present();
  }, []);

  // App-lock toggle. We require a successful biometric prompt before
  // enabling so we know the device can actually unlock — and before
  // disabling so a passer-by can't flip it off after grabbing an
  // unattended phone.
  const appLockEnabled = useAppLock((s) => s.enabled);
  const appLockAvailable = useAppLock((s) => s.available);
  const setAppLockEnabled = useAppLock((s) => s.setEnabled);
  const onToggleAppLock = useCallback(
    (next: boolean) => {
      void (async () => {
        const ok = await authenticateBiometric();
        if (!ok) return;
        await setAppLockEnabled(next);
        showToast(next ? "App lock on" : "App lock off", "success");
      })();
    },
    [setAppLockEnabled],
  );

  // Force the lock overlay open without going through the biometric path —
  // simulator-only affordance for previewing the UI.
  const previewAppLock = useCallback(() => {
    useAppLock.setState({ locked: true });
  }, []);

  const onSignOutEverywhere = () => {
    Alert.alert(
      "Sign out everywhere?",
      "All other devices will be signed out, plus this one. You'll need to log back in.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign out",
          style: "destructive",
          onPress: async () => {
            // Revoke every session the gateway knows about.
            const sessions = sessionsQ.data ?? [];
            for (const s of sessions) {
              if (s.revokedAt) continue;
              try {
                await revokeAuthSession(s.id);
              } catch {
                // Best-effort — continue revoking remaining sessions.
              }
            }
            // Then clear local refresh token (covers the case where the
            // session list was empty / failed to load).
            if (refreshToken) {
              await apiLogout(refreshToken);
            }
            await clearPushTokenWithBackend();
            await clearAuth();
            router.replace("/login");
          },
        },
      ],
    );
  };

  const onSheetSuccess = useCallback(() => {
    sheetRef.current?.dismiss();
  }, []);

  return (
    <PhoneSafeArea>
      <NavBar title="Account & security" onBack={() => router.back()} />
      <ScrollView
        contentContainerStyle={{ paddingBottom: 60 }}
        refreshControl={
          <RefreshControl
            refreshing={sessionsQ.isRefetching}
            onRefresh={() => sessionsQ.refetch()}
            tintColor={tokens.accent}
            colors={[tokens.accent]}
          />
        }
      >
        <Stack gap={18} style={{ paddingTop: 12 }}>
          {/* Identity card. */}
          <View
            className="bg-surface border border-line"
            style={{ marginHorizontal: 16, padding: 16, borderRadius: 14 }}
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
                <Text kind="h3" color={tokens.accent}>
                  {(user?.username?.[0] ?? "?").toUpperCase()}
                </Text>
              </View>
              <Stack gap={2} style={{ flex: 1 }}>
                <Text kind="h3">{user?.username ?? "(unknown)"}</Text>
                <Text kind="caption" className="text-ink-3">
                  Signed in
                </Text>
              </Stack>
              <StatusPill kind="online" label="active" />
            </Row>
          </View>

          {/* Server. */}
          <Section title="Server">
            <ListGroup>
              <ListRow
                icon="globe"
                title="Gateway URL"
                subtitle={API_URL}
                chevron={false}
              />
            </ListGroup>
          </Section>

          {/* Password. */}
          <Section title="Password">
            <ListGroup>
              <ListRow
                icon="key"
                title="Change password"
                chevron
                onPress={onChangePasswordPress}
              />
            </ListGroup>
          </Section>

          {/* App lock. */}
          <Section title="App lock">
            <ListGroup
              footer={
                appLockAvailable
                  ? "Requires FaceID, TouchID, or your device passcode each time the app opens or returns from the background."
                  : "Biometric hardware not detected — usually the case in a simulator. The toggle is hidden until you run on a real device."
              }
            >
              {appLockAvailable ? (
                <ListRow
                  icon="shieldCheck"
                  title="Require biometric on launch"
                  right={
                    <Toggle on={appLockEnabled} onChange={onToggleAppLock} />
                  }
                />
              ) : (
                <>
                  <ListRow
                    icon="shieldCheck"
                    title="Biometric lock"
                    detail="unavailable"
                  />
                  {/* Dev affordance — only rendered when no biometrics are
                      enrolled (i.e. simulator / emulator). Lets you preview
                      the lock UI without owning a real device; the overlay
                      reveals a "Skip (no biometric)" button in this state. */}
                  <ListRow
                    icon="eye"
                    title="Preview lock screen"
                    subtitle="Simulator-only — opens the lock overlay"
                    chevron
                    onPress={previewAppLock}
                  />
                </>
              )}
            </ListGroup>
          </Section>

          {/* Active sessions. */}
          <Section title="Active sessions">
            {sessionsQ.isLoading ? (
              <View style={{ padding: 24, alignItems: "center" }}>
                <ActivityIndicator color={tokens.accent} />
              </View>
            ) : sessionsQ.isError ? (
              <EmptyState
                icon="shield"
                title="Couldn't load sessions"
                body={
                  sessionsQ.error instanceof Error
                    ? sessionsQ.error.message
                    : "Pull down to retry."
                }
                action={
                  <Button
                    kind="secondary"
                    onClick={() => sessionsQ.refetch()}
                  >
                    Retry
                  </Button>
                }
              />
            ) : (sessionsQ.data ?? []).filter((s) => !s.revokedAt).length === 0 ? (
              <ListGroup footer="No active sessions on the gateway.">
                <ListRow title="None" chevron={false} />
              </ListGroup>
            ) : (
              <ListGroup footer="Each row is a refresh token. Revoke to sign that device out.">
                {(sessionsQ.data ?? [])
                  .filter((s) => !s.revokedAt)
                  .map((s) => (
                    <ListRow
                      key={s.id}
                      icon="user"
                      iconColor={s.current ? tokens.accentBg : undefined}
                      title={
                        s.current
                          ? "This device"
                          : `Created ${formatRelative(s.createdAt)}`
                      }
                      subtitle={`Expires ${formatExpires(s)}`}
                      right={
                        s.current ? (
                          <StatusPill kind="online" label="current" />
                        ) : (
                          <Button
                            kind="danger"
                            size="sm"
                            disabled={revokeMut.isPending}
                            onClick={() => revokeMut.mutate(s.id)}
                          >
                            Revoke
                          </Button>
                        )
                      }
                      chevron={false}
                    />
                  ))}
              </ListGroup>
            )}
          </Section>

          {/* Danger zone. */}
          <Section title="Danger zone">
            <ListGroup>
              <ListRow
                icon="bolt"
                iconColor={tokens.danger + "26"}
                title="Sign out everywhere"
                danger
                chevron
                onPress={onSignOutEverywhere}
              />
            </ListGroup>
          </Section>
        </Stack>
      </ScrollView>

      {/* Change-password sheet — standardized form height. */}
      <Sheet ref={sheetRef} snapPoints={["60%"]}>
        <ChangePasswordForm onSuccess={onSheetSuccess} />
      </Sheet>
    </PhoneSafeArea>
  );
}

interface ChangePasswordFormProps {
  onSuccess: () => void;
}

function ChangePasswordForm({ onSuccess }: ChangePasswordFormProps) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  // Per-field errors so we can surface mismatch on the confirm field and
  // length on the new-password field — instead of a single bottom-of-form blob.
  const [currentError, setCurrentError] = useState<string | null>(null);
  const [nextError, setNextError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: () =>
      changePassword({ currentPassword: current, newPassword: next }),
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setConfirm("");
      setCurrentError(null);
      setNextError(null);
      setConfirmError(null);
      showToast("Password updated", "success");
      onSuccess();
    },
    onError: (err: unknown) => {
      // Backend disambiguates current-vs-new failures via specific codes —
      // map them onto the right field. Anything else hits the toast path.
      const msg = extractErrorMessage(err);
      if (msg === "Current password is incorrect.") {
        setCurrentError(msg);
      } else if (msg === "New password is too weak.") {
        setNextError(msg);
      } else {
        setNextError(msg);
      }
    },
    // Field-level errors handle this; suppress the global error toast so the
    // user only sees one source of truth.
    meta: { silent: true },
  });

  const onSubmit = () => {
    setCurrentError(null);
    setNextError(null);
    setConfirmError(null);
    let hasErr = false;
    if (!current) {
      setCurrentError("Enter your current password.");
      hasErr = true;
    }
    if (next.length < MIN_PASSWORD_LEN) {
      setNextError(`Must be at least ${MIN_PASSWORD_LEN} characters.`);
      hasErr = true;
    }
    if (next !== confirm) {
      setConfirmError("Passwords don't match.");
      hasErr = true;
    }
    if (hasErr) return;
    mut.mutate();
  };

  return (
    <Stack gap={14} style={{ padding: 20 }}>
      <Text kind="h3">Change password</Text>
      <Text kind="caption" className="text-ink-3">
        New password must be at least {MIN_PASSWORD_LEN} characters.
      </Text>
      <Field
        label="Current password"
        error={currentError ?? undefined}
      >
        <Input
          value={current}
          onChange={(t) => {
            setCurrent(t);
            if (currentError) setCurrentError(null);
          }}
          secureTextEntry
          placeholder="••••••••"
        />
      </Field>
      <Field label="New password" error={nextError ?? undefined}>
        <Input
          value={next}
          onChange={(t) => {
            setNext(t);
            if (nextError) setNextError(null);
          }}
          secureTextEntry
          placeholder="At least 12 chars"
        />
      </Field>
      <Field
        label="Confirm new password"
        error={confirmError ?? undefined}
      >
        <Input
          value={confirm}
          onChange={(t) => {
            setConfirm(t);
            if (confirmError) setConfirmError(null);
          }}
          secureTextEntry
          placeholder="Repeat new password"
        />
      </Field>
      <Button
        kind="accent"
        full
        leftIcon="check"
        disabled={mut.isPending}
        onClick={onSubmit}
      >
        {mut.isPending ? "Updating…" : "Update password"}
      </Button>
    </Stack>
  );
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (typeof err.body === "string") return err.body;
    if (err.body && typeof err.body === "object") {
      const msg = err.body.error;
      if (msg === "current_password_incorrect") {
        return "Current password is incorrect.";
      }
      if (msg === "new_password_too_weak") {
        return "New password is too weak.";
      }
      return msg || `Request failed (${err.status})`;
    }
    return `Request failed (${err.status})`;
  }
  if (err instanceof Error) return err.message;
  return "Unknown error";
}
