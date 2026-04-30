/**
 * Chip — pill-shaped tag (matches ui.jsx::Chip).
 * h=26, radius full. Active = bg-ink/text-surface, default = bg-chip/text-ink-2.
 */
import React from "react";
import { Pressable, type StyleProp, type ViewStyle } from "react-native";
import { Text } from "./Text";

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
  const handler = onClick ?? onPress;
  return (
    <Pressable
      onPress={handler}
      className={
        "flex-row items-center" +
        (active ? " bg-ink" : color ? "" : " bg-chip")
      }
      style={[
        {
          height: 26,
          paddingHorizontal: 10,
          borderRadius: 999,
          gap: 6,
          backgroundColor: !active && color ? color : undefined,
        },
        style,
      ]}
    >
      <Text
        kind="caption"
        className={active ? "text-surface" : "text-ink-2"}
        style={{ fontWeight: "500" }}
      >
        {children}
      </Text>
    </Pressable>
  );
}
