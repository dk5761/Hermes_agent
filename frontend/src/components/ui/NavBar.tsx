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

  // Large variant on tab roots usually has no back/leading/trailing — skip
  // rendering the toolbar Row so the display title sits directly under the
  // status bar with minimal dead space. Render the Row only when there's
  // something to put in it.
  const hasToolbar = !!onBack || !!leading || !!trailing || !large;

  return (
    <Stack
      className="bg-bg"
      style={{
        paddingTop: insets.top + (large && !hasToolbar ? 4 : 8),
        paddingBottom: large ? 8 : 12,
      }}
    >
      {hasToolbar ? (
        <Row
          align="center"
          style={{ paddingHorizontal: 16, minHeight: 36, gap: 8 }}
        >
          <Row gap={4} style={{ flexShrink: 0 }}>
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
            // Title takes the slack between leading + trailing and
            // ellipsizes when long. Centered text alignment keeps it
            // visually balanced on screens where leading/trailing are
            // similar in width.
            <View style={{ flex: 1, minWidth: 0, alignItems: "center" }}>
              <Text
                kind="h3"
                numberOfLines={1}
                ellipsizeMode="tail"
                style={{ textAlign: "center" }}
              >
                {title}
              </Text>
            </View>
          ) : (
            <View style={{ flex: 1 }} />
          )}
          <Row gap={4} style={{ flexShrink: 0 }}>
            {trailing}
          </Row>
        </Row>
      ) : null}
      {large && title ? (
        <Stack gap={2} style={{ paddingHorizontal: 16, paddingTop: hasToolbar ? 8 : 0, paddingBottom: 4 }}>
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
