import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Screen } from "@/components/Screen";
import { Button } from "@/components/Button";
import { TextField } from "@/components/TextField";
import { login } from "@/api/auth";
import { useAuthStore } from "@/auth/store";
import { ApiError } from "@/api/types";
import { ACCENT, MUTED } from "@/config";

export default function LoginScreen() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setSession = useAuthStore((s) => s.setSession);

  const onSubmit = async () => {
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
    } catch (err) {
      if (err instanceof ApiError) {
        const code = typeof err.body === "string" ? err.body : err.body.error;
        setError(code === "invalid_credentials" ? "Invalid credentials." : `Error: ${code}`);
      } else {
        setError("Network error. Check API URL.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <KeyboardAvoidingView
        style={styles.kav}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.brandWrap}>
            <Text style={styles.brand}>Hermes</Text>
            <Text style={styles.subtitle}>sign in to continue</Text>
          </View>
          <View style={styles.form}>
            <TextField
              label="username"
              value={username}
              onChangeText={setUsername}
              autoComplete="username"
              textContentType="username"
              placeholder="user"
              editable={!busy}
            />
            <TextField
              label="password"
              value={password}
              onChangeText={setPassword}
              autoComplete="password"
              textContentType="password"
              placeholder="********"
              secureTextEntry
              editable={!busy}
              onSubmitEditing={onSubmit}
            />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Button label="Sign in" onPress={onSubmit} loading={busy} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  kav: { flex: 1 },
  scroll: { flexGrow: 1, justifyContent: "center", paddingVertical: 24, gap: 24 },
  brandWrap: { alignItems: "center", gap: 4 },
  brand: { color: ACCENT, fontSize: 36, fontWeight: "800", letterSpacing: 1 },
  subtitle: { color: MUTED, fontSize: 13 },
  form: { gap: 14 },
  error: { color: "#FCA5A5", fontSize: 13 },
});
