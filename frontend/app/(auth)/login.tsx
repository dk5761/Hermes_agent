/**
 * Login — Stage 5 redesign.
 * Visual target: design/screens-1.jsx::LoginScreen.
 *
 * Single screen (no onboarding sequence — user opted for "minimal login only").
 * Uses Stage 2 component library + Stage 1 theme tokens. Preserves the
 * existing auth flow (api/auth.login + setSession + ApiError handling).
 */
import React, { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import {
  Button,
  Field,
  HermesMark,
  Input,
  PhoneSafeArea,
  Row,
  showToast,
  Stack,
  StatusDot,
  Text,
} from "@/components/ui";
import { useThemeTokens } from "@/components/ui/tokens";
import { login } from "@/api/auth";
import { ApiError } from "@/api/types";
import { useAuthStore } from "@/auth/store";
import { API_URL } from "@/config";

interface GatewayStatus {
  ok: boolean;
  uptimeS?: number;
}

export default function LoginScreen() {
  const tokens = useThemeTokens();
  const setSession = useAuthStore((s) => s.setSession);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<GatewayStatus | null>(null);

  // Best-effort health ping so the footer reflects whether the gateway is
  // actually reachable. Bypasses the auth client (no token needed for /health).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/health`, { method: "GET" });
        if (cancelled) return;
        if (res.ok) {
          const body = (await res.json()) as { status?: string; uptimeS?: number };
          setStatus({ ok: body.status === "ok", uptimeS: body.uptimeS });
        } else {
          setStatus({ ok: false });
        }
      } catch {
        if (!cancelled) setStatus({ ok: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onSubmit = async (): Promise<void> => {
    if (!username.trim() || !password) {
      setError("Enter username and password.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await login(username.trim(), password);
      await setSession({
        accessToken: res.accessToken,
        refreshToken: res.refreshToken,
        user: res.user,
      });
      // Confirm sign-in via toast — useful when redirect is slightly delayed.
      showToast(`Welcome back, ${res.user.username}`, "success");
    } catch (err) {
      if (err instanceof ApiError) {
        const code = typeof err.body === "string" ? err.body : err.body.error;
        setError(
          code === "invalid_credentials"
            ? "Invalid credentials. Check your gateway URL below."
            : `Error: ${code}`,
        );
      } else {
        setError("Network error. Check your gateway URL.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <PhoneSafeArea edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 24 }}
          keyboardShouldPersistTaps="handled"
        >
          {/* Top spacer + main form column */}
          <View style={{ height: 32 }} />
          <Stack gap={32} style={{ flex: 1, paddingTop: 40 }}>
            {/* Brand */}
            <Stack gap={16}>
              <HermesMark size={28} />
              <Stack gap={8}>
                <Text kind="display">Welcome back.</Text>
                <Text kind="body" color={tokens.ink3}>
                  Sign in to your Hermes gateway.
                </Text>
              </Stack>
            </Stack>

            {/* Form */}
            <Stack gap={16}>
              <Field label="Username">
                <Input
                  value={username}
                  onChange={setUsername}
                  icon="user"
                  textInputProps={{
                    autoComplete: "username",
                    textContentType: "username",
                    autoCapitalize: "none",
                    autoCorrect: false,
                    editable: !busy,
                  }}
                />
              </Field>

              <Field label="Password" hint="Used to derive your local key.">
                <Input
                  value={password}
                  onChange={setPassword}
                  type="password"
                  secureTextEntry
                  icon="key"
                  onSubmit={onSubmit}
                  textInputProps={{
                    autoComplete: "password",
                    textContentType: "password",
                    autoCapitalize: "none",
                    autoCorrect: false,
                    editable: !busy,
                  }}
                />
              </Field>

              {error ? (
                <View
                  style={{
                    paddingVertical: 10,
                    paddingHorizontal: 12,
                    backgroundColor: tokens.accentBg,
                    borderRadius: 10,
                    borderWidth: 1,
                    borderColor: tokens.danger + "33",
                  }}
                >
                  <Text kind="caption" color={tokens.danger}>
                    {error}
                  </Text>
                </View>
              ) : null}

              <Button
                kind="accent"
                size="lg"
                full
                onClick={onSubmit}
                rightIcon={busy ? undefined : "chevR"}
              >
                {busy ? "Signing in…" : "Sign in"}
              </Button>
            </Stack>
          </Stack>

          {/* Footer pinned to bottom of the scroll view */}
          <Stack gap={6} style={{ paddingTop: 32, paddingBottom: 32 }}>
            <Text
              kind="micro"
              color={tokens.ink3}
              style={{ textTransform: "uppercase" }}
            >
              Connecting to
            </Text>
            <Text kind="caption" mono color={tokens.ink2}>
              {API_URL}
            </Text>
            <Row gap={6} align="center" style={{ marginTop: 4 }}>
              <StatusDot kind={status === null ? "idle" : status.ok ? "online" : "offline"} />
              <Text kind="caption" color={tokens.ink3}>
                {status === null
                  ? "Checking gateway…"
                  : status.ok
                    ? `Gateway reachable${status.uptimeS ? ` · uptime ${formatUptime(status.uptimeS)}` : ""}`
                    : "Gateway unreachable"}
              </Text>
            </Row>
          </Stack>
        </ScrollView>
      </KeyboardAvoidingView>
    </PhoneSafeArea>
  );
}

function formatUptime(s: number): string {
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}
