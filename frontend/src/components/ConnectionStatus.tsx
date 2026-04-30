import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ConnectionStatus as Status } from "../ws/client";
import { ACCENT, BORDER, DANGER, MUTED, PANEL } from "../config";

interface Props {
  status: Status;
  retryInMs: number | null;
  onReload?: () => void;
}

const labelFor = (s: Status, retryInMs: number | null): string => {
  switch (s) {
    case "idle":
      return "Idle";
    case "connecting":
      return "Connecting...";
    case "open":
      return "Online";
    case "reconnecting":
      return retryInMs ? `Reconnecting in ${Math.ceil(retryInMs / 1000)}s` : "Reconnecting...";
    case "sync_required":
      return "Reload required";
    case "auth_required":
      return "Auth required";
    case "closed":
      return "Disconnected";
  }
};

const colorFor = (s: Status): string => {
  switch (s) {
    case "open":
      return ACCENT;
    case "sync_required":
    case "auth_required":
      return DANGER;
    case "reconnecting":
    case "connecting":
      return "#F5A524";
    default:
      return MUTED;
  }
};

export function ConnectionStatus({ status, retryInMs, onReload }: Props) {
  // Hide the banner when everything is fine to keep the chat clean.
  if (status === "open") return null;

  const showReload = status === "sync_required" && onReload;
  return (
    <View style={[styles.bar, { borderColor: BORDER }]}>
      <View style={[styles.dot, { backgroundColor: colorFor(status) }]} />
      <Text style={styles.label}>{labelFor(status, retryInMs)}</Text>
      {showReload ? (
        <Pressable onPress={onReload} style={styles.btn} accessibilityRole="button">
          <Text style={styles.btnText}>Reload</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: PANEL,
    borderBottomWidth: 1,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  label: {
    color: "#E8EAED",
    fontSize: 13,
    flex: 1,
  },
  btn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: ACCENT,
  },
  btnText: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "600",
  },
});
