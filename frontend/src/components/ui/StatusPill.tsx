/**
 * StatusPill — dot + label, padded pill (matches ui.jsx::StatusPill).
 *
 * online/connecting/offline: transparent bg + line border, colored text.
 * paused/other: chip bg, no border, ink-2 text.
 */
import React from "react";
import { View } from "react-native";
import { Row } from "./Row";
import { StatusDot, type StatusDotKind } from "./StatusDot";
import { Text } from "./Text";
import { useThemeTokens } from "./tokens";

export type StatusPillKind = "online" | "connecting" | "offline" | "paused" | "idle";

export interface StatusPillProps {
  kind: StatusPillKind;
  label: string;
}

export function StatusPill({ kind, label }: StatusPillProps) {
  const tokens = useThemeTokens();

  const map: Record<
    StatusPillKind,
    { bg: string | "transparent"; fg: string; dot: StatusDotKind }
  > = {
    online: { bg: "transparent", fg: tokens.positive, dot: "online" },
    connecting: { bg: "transparent", fg: tokens.warning, dot: "connecting" },
    offline: { bg: "transparent", fg: tokens.danger, dot: "offline" },
    paused: { bg: tokens.chip, fg: tokens.ink2, dot: "idle" },
    idle: { bg: tokens.chip, fg: tokens.ink2, dot: "idle" },
  };
  const s = map[kind];
  const transparent = s.bg === "transparent";

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 999,
        backgroundColor: transparent ? undefined : s.bg,
        borderWidth: transparent ? 1 : 0,
        borderColor: transparent ? tokens.line : undefined,
      }}
    >
      <StatusDot kind={s.dot} />
      <Text
        kind="caption"
        color={s.fg}
        style={{ fontWeight: "500" }}
      >
        {label}
      </Text>
    </View>
  );
}

// Re-export Row (used by callers that destructure both).
export { Row };
