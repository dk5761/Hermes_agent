/**
 * Chip — pill-shaped tag (matches ui.jsx::Chip).
 * h=26, radius full.
 *
 * Active state uses `accent` background so it stays visible across light AND
 * dark themes. (The handoff prototype uses `ink` for active, but Uniwind's
 * className → bg propagation on Pressable is unreliable in some RN/Reanimated
 * combos, and `bg-ink` in light mode renders nearly black on white anyway —
 * accent is more legible AND signals "selected" the way users expect.)
 *
 * Background + text color applied via inline style from useThemeTokens for
 * bulletproof coverage.
 */
import React from "react";
import { Pressable, type StyleProp, type ViewStyle } from "react-native";
import { Text } from "./Text";
import { useThemeTokens } from "./tokens";

export interface ChipProps {
  active?: boolean;
  onClick?: () => void;
  onPress?: () => void;
  /** Custom background color override (hex). Ignored when `active`. */
  color?: string;
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function Chip({ active, onClick, onPress, color, children, style }: ChipProps) {
  const tokens = useThemeTokens();
  const handler = onClick ?? onPress;
  const bgColor = active ? tokens.accent : color ?? tokens.chip;
  const textColor = active ? "#FFFFFF" : tokens.ink2;
  return (
    <Pressable
      onPress={handler}
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          height: 26,
          paddingHorizontal: 10,
          borderRadius: 999,
          gap: 6,
          backgroundColor: bgColor,
        },
        style,
      ]}
    >
      <Text kind="caption" color={textColor} style={{ fontWeight: "500" }}>
        {children}
      </Text>
    </Pressable>
  );
}
