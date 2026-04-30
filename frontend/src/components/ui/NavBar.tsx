/**
 * NavBar — top bar (matches ui.jsx::NavBar). Two layouts:
 *   compact: title centered (`text-h3`), leading + trailing slots.
 *   large:   title left-aligned (`text-display`) with optional subtitle.
 *
 * Adds the device's safe-area top inset so it sits below the notch/island.
 * Uses absolute positioning for the centered title (so leading/trailing
 * slots don't shift it off-center).
 */
import React from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "./Icon";
import { Row } from "./Row";
import { Stack } from "./Stack";
import { Text } from "./Text";
import { useThemeTokens } from "./tokens";

export interface NavBarProps {
  title?: string;
  subtitle?: string;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  large?: boolean;
  onBack?: () => void;
}

export function NavBar({
  title,
  subtitle,
  leading,
  trailing,
  large,
  onBack,
}: NavBarProps) {
  const insets = useSafeAreaInsets();
  const tokens = useThemeTokens();

  return (
    <Stack
      className="bg-bg"
      style={{
        paddingTop: insets.top + 8,
        paddingBottom: large ? 8 : 12,
      }}
    >
      <Row
        align="center"
        justify="space-between"
        style={{ paddingHorizontal: 16, minHeight: 36 }}
      >
        <Row gap={4} style={{ minWidth: 0 }}>
          {onBack ? (
            <Pressable
              onPress={onBack}
              style={{
                padding: 6,
                marginLeft: -6,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon name="chevL" size={22} color={tokens.accent} />
            </Pressable>
          ) : null}
          {leading}
        </Row>
        {!large && title ? (
          // Absolute-centered title so trailing/leading slot widths don't
          // bias horizontal placement.
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              alignItems: "center",
            }}
          >
            <Text kind="h3">{title}</Text>
          </View>
        ) : null}
        <Row gap={4}>{trailing}</Row>
      </Row>
      {large && title ? (
        <Stack gap={2} style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 }}>
          <Text kind="display">{title}</Text>
          {subtitle ? (
            <Text kind="body" className="text-ink-3">
              {subtitle}
            </Text>
          ) : null}
        </Stack>
      ) : null}
    </Stack>
  );
}
