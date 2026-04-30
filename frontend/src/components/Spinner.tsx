import { ActivityIndicator, StyleSheet, View } from "react-native";
import { MUTED } from "../config";

export function Spinner({ size = "small" }: { size?: "small" | "large" }) {
  return (
    <View style={styles.center}>
      <ActivityIndicator size={size} color={MUTED} />
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
});
