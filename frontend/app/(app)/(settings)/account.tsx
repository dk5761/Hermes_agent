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
  Stack,
  StatusPill,
  Text,
  useThemeTokens,
  type SheetHandle,
} from "@/components/ui";
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

  const revokeMut = useMutation({
    mutationFn: (id: string) => revokeAuthSession(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["auth", "sessions"] }),
    onError: (err: unknown) => {
      Alert.alert("Couldn't revoke", extractErrorMessage(err));
    },
  });

  const onChangePasswordPress = useCallback(() => {
    sheetRef.current?.present();
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

      {/* Change-password sheet. */}
      <Sheet ref={sheetRef} snapPoints={["70%"]}>
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
  const [error, setError] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: () =>
      changePassword({ currentPassword: current, newPassword: next }),
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setConfirm("");
      setError(null);
      onSuccess();
    },
    onError: (err: unknown) => {
      setError(extractErrorMessage(err));
    },
  });

  const onSubmit = () => {
    setError(null);
    if (!current) {
      setError("Enter your current password.");
      return;
    }
    if (next.length < MIN_PASSWORD_LEN) {
      setError(`New password must be at least ${MIN_PASSWORD_LEN} characters.`);
      return;
    }
    if (next !== confirm) {
      setError("New password and confirmation don't match.");
      return;
    }
    mut.mutate();
  };

  return (
    <Stack gap={14} style={{ padding: 20 }}>
      <Text kind="h3">Change password</Text>
      <Text kind="caption" className="text-ink-3">
        New password must be at least {MIN_PASSWORD_LEN} characters.
      </Text>
      <Field label="Current password">
        <Input
          value={current}
          onChange={setCurrent}
          secureTextEntry
          placeholder="••••••••"
        />
      </Field>
      <Field label="New password">
        <Input
          value={next}
          onChange={setNext}
          secureTextEntry
          placeholder="At least 12 chars"
        />
      </Field>
      <Field
        label="Confirm new password"
        error={error ?? undefined}
      >
        <Input
          value={confirm}
          onChange={setConfirm}
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
