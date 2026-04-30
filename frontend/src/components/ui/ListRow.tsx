/**
 * ListRow — density-aware row (matches ui.jsx::ListRow).
 *
 * Density rule: comfortable=56pt, compact=44pt (read from useTheme().density).
 * Icon tile is 30x30 with bg-chip; iconColor overrides background and forces
 * white icon stroke (mirrors design).
 */
import React from "react";
import { Pressable, View } from "react-native";
import { useTheme } from "@/theme";
import { Icon, type IconName } from "./Icon";
import { Text } from "./Text";
import { useThemeTokens } from "./tokens";

export interface ListRowProps {
  icon?: IconName;
  /** Hex string. If passed, icon tile uses this color and icon stroke is white. */
  iconColor?: string;
  title: string;
  subtitle?: string;
  detail?: string;
  right?: React.ReactNode;
  chevron?: boolean;
  danger?: boolean;
  onClick?: () => void;
  onPress?: () => void;
}

export function ListRow({
  icon,
  iconColor,
  title,
  subtitle,
  detail,
  right,
  chevron,
  danger,
  onClick,
  onPress,
}: ListRowProps) {
  const { density } = useTheme();
  const tokens = useThemeTokens();
  const handler = onClick ?? onPress;
  // Density-aware row height per spec.
  const minHeight = density === "comfortable" ? 56 : 44;
  // Density-aware vertical padding so text breathes properly at both sizes.
  const paddingVertical = density === "comfortable" ? 12 : 8;
  const iconBg = iconColor ?? tokens.chip;
  const iconStroke = iconColor ? "#FFFFFF" : tokens.ink;

  const Wrapper = handler ? Pressable : View;

  return (
    <Wrapper
      onPress={handler}
      style={{
        minHeight,
        paddingVertical,
        paddingHorizontal: 16,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
      }}
    >
      {icon ? (
        <View
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            backgroundColor: iconBg,
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <Icon name={icon} size={16} color={iconStroke} />
        </View>
      ) : null}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text
          kind="body-lg"
          numberOfLines={1}
          className={danger ? "text-danger" : ""}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text kind="caption" className="text-ink-3" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {detail ? (
        <Text kind="body" className="text-ink-3">
          {detail}
        </Text>
      ) : null}
      {right}
      {chevron ? <Icon name="chevR" size={16} color={tokens.ink3} /> : null}
    </Wrapper>
  );
}
