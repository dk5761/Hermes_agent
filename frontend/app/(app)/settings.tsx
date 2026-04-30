import { Pressable, StyleSheet, Text, View } from "react-native";
import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { Screen } from "@/components/Screen";
import { Button } from "@/components/Button";
import { useAuthStore } from "@/auth/store";
import { logout as apiLogout } from "@/api/auth";
import { ACCENT, API_URL, MUTED, TEXT, WS_URL } from "@/config";

export default function SettingsScreen() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const refreshToken = useAuthStore((s) => s.refreshToken);
  const clear = useAuthStore((s) => s.clear);
  const version = Constants.expoConfig?.version ?? "0.0.0";

  const onLogout = async () => {
    if (refreshToken) await apiLogout(refreshToken);
    await clear();
    router.replace("/login");
  };

  return (
    <Screen>
      <View style={styles.body}>
        <View style={styles.section}>
          <Text style={styles.label}>signed in as</Text>
          <Text style={styles.value}>{user?.username ?? "(unknown)"}</Text>
        </View>
        <View style={styles.section}>
          <Text style={styles.label}>api</Text>
          <Text style={styles.valueMono}>{API_URL}</Text>
        </View>
        <View style={styles.section}>
          <Text style={styles.label}>websocket</Text>
          <Text style={styles.valueMono}>{WS_URL}</Text>
        </View>
        <View style={styles.section}>
          <Text style={styles.label}>version</Text>
          <Text style={styles.value}>{version}</Text>
        </View>

        <Pressable
          onPress={() => router.push("/settings/vision")}
          style={({ pressed }) => [styles.linkRow, pressed && { opacity: 0.6 }]}
        >
          <View style={{ flex: 1 }}>
            <Text style={styles.linkLabel}>Vision (auxiliary model)</Text>
            <Text style={styles.linkHint}>Configure the model used for images when main is text-only</Text>
          </View>
          <Text style={styles.chev}>›</Text>
        </Pressable>

        {__DEV__ ? (
          <Pressable
            onPress={() => router.push("/__theme")}
            style={({ pressed }) => [styles.linkRow, pressed && { opacity: 0.6 }]}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.linkLabel}>Theme debug (dev)</Text>
              <Text style={styles.linkHint}>Stage 1 visual regression — color tokens, type scale, all 6 themes</Text>
            </View>
            <Text style={styles.chev}>›</Text>
          </Pressable>
        ) : null}

        {__DEV__ ? (
          <Pressable
            onPress={() => router.push("/__components")}
            style={({ pressed }) => [styles.linkRow, pressed && { opacity: 0.6 }]}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.linkLabel}>Components debug (dev)</Text>
              <Text style={styles.linkHint}>Stage 2 component library — every primitive in every variant</Text>
            </View>
            <Text style={styles.chev}>›</Text>
          </Pressable>
        ) : null}

        <View style={styles.spacer} />
        <Button label="Log out" variant="danger" onPress={onLogout} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, paddingVertical: 16, gap: 18 },
  section: { gap: 4 },
  label: {
    color: MUTED,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  value: { color: TEXT, fontSize: 15 },
  valueMono: { color: TEXT, fontSize: 13, fontFamily: "Menlo" },
  linkRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: 14,
    backgroundColor: "#0C1015",
    borderRadius: 10,
    gap: 12,
    borderWidth: 1,
    borderColor: "#1E242C",
    marginTop: 4,
  },
  linkLabel: { color: TEXT, fontSize: 15 },
  linkHint: { color: MUTED, fontSize: 11, marginTop: 2 },
  chev: { color: ACCENT, fontSize: 22, fontWeight: "300" },
  spacer: { flex: 1 },
});
