import { ActivityIndicator, Pressable, StyleSheet, Text } from "react-native";
import { ACCENT, BORDER, PANEL, TEXT } from "../config";

type Variant = "primary" | "secondary" | "danger" | "ghost";

interface ButtonProps {
  label: string;
  onPress?: () => void;
  variant?: Variant;
  disabled?: boolean;
  loading?: boolean;
  compact?: boolean;
}

const palette: Record<Variant, { bg: string; fg: string; border: string }> = {
  primary: { bg: ACCENT, fg: "#FFFFFF", border: ACCENT },
  secondary: { bg: PANEL, fg: TEXT, border: BORDER },
  danger: { bg: "#3A1418", fg: "#FCA5A5", border: "#5A1A22" },
  ghost: { bg: "transparent", fg: TEXT, border: "transparent" },
};

export function Button({
  label,
  onPress,
  variant = "primary",
  disabled = false,
  loading = false,
  compact = false,
}: ButtonProps) {
  const c = palette[variant];
  const isInactive = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isInactive, busy: loading }}
      onPress={isInactive ? undefined : onPress}
      style={({ pressed }) => [
        styles.base,
        compact && styles.compact,
        {
          backgroundColor: c.bg,
          borderColor: c.border,
          opacity: isInactive ? 0.55 : pressed ? 0.85 : 1,
        },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={c.fg} />
      ) : (
        <Text style={[styles.label, { color: c.fg }]}>{label}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
  },
  compact: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    minHeight: 34,
  },
  label: {
    fontSize: 15,
    fontWeight: "600",
  },
});

