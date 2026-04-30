/**
 * StatusDot — 6x6 colored dot (matches ui.jsx::StatusDot).
 *   online → positive · connecting → warning · offline → danger · idle → ink-3
 */
import React from "react";
import { View } from "react-native";
import { useThemeTokens } from "./tokens";

export type StatusDotKind = "online" | "connecting" | "offline" | "idle";

export interface StatusDotProps {
  kind?: StatusDotKind;
}

export function StatusDot({ kind = "online" }: StatusDotProps) {
  const tokens = useThemeTokens();
  const color =
    kind === "online"
      ? tokens.positive
      : kind === "connecting"
        ? tokens.warning
        : kind === "offline"
          ? tokens.danger
          : tokens.ink3;
  return (
    <View
      style={{
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: color,
      }}
    />
  );
}
