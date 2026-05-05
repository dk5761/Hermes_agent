/**
 * AppTabBar — custom bottom tab bar for the (app) tabs.
 *
 * Visual target: design/app.jsx::HeroTabBar — floating pill, 4px padding,
 * rounded-full radius 28, blurred translucent background, border line, soft
 * shadow. Active tab: bg-ink, text-surface. Inactive: transparent, text-ink-2.
 *
 * Hides itself on push depth (any route deeper than the tab root). The check
 * is conservative: if the last segment isn't the tab group name itself, we
 * treat that as "inside a stack child" and render nothing so the bar doesn't
 * cover detail screens.
 */
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { BlurView } from "expo-blur";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSegments } from "expo-router";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { Icon, type IconName } from "./Icon";
import { useThemeTokens } from "./tokens";
import { useTheme } from "@/theme";

interface TabSpec {
  routeName: string;
  icon: IconName;
  label: string;
}

const TABS: readonly TabSpec[] = [
  { routeName: "(chats)", icon: "terminal", label: "Chats" },
  { routeName: "(cron)", icon: "clock", label: "Cron" },
  { routeName: "(settings)", icon: "cog", label: "Settings" },
] as const;

export function AppTabBar(props: BottomTabBarProps): React.ReactElement | null {
  const { state, navigation } = props;
  const insets = useSafeAreaInsets();
  const tokens = useThemeTokens();
  // Use the *resolved* mode (always "light" | "dark") — `mode` itself can be
  // "system", which would mis-route the tint when OS is dark.
  const { resolvedMode } = useTheme();
  const segments = useSegments();

  // Hide on push depth: segments after `(app)` and the active group should be
  // empty for tab roots. Anything deeper means we're inside a Stack child.
  const appIdx = segments.indexOf("(app)" as never);
  const afterApp = appIdx >= 0 ? segments.slice(appIdx + 1) : segments;
  const depthInsideTab = afterApp.length > 1;
  if (depthInsideTab) return null;

  const bottom = Math.max(insets.bottom, 12);

  return (
    <View
      pointerEvents="box-none"
      style={[styles.wrap, { bottom: bottom + 4 }]}
    >
      <BlurView
        intensity={40}
        tint={resolvedMode}
        style={[
          styles.bar,
          {
            borderColor: tokens.line,
            backgroundColor:
              resolvedMode === "dark"
                ? "rgba(28,28,30,0.55)"
                : "rgba(255,255,255,0.55)",
          },
        ]}
      >
        {TABS.map((tab, idx) => {
          const route = state.routes.find((r) => r.name === tab.routeName);
          if (!route) return null;
          const active = state.index === state.routes.indexOf(route);
          const onPress = () => {
            const event = navigation.emit({
              type: "tabPress",
              target: route.key,
              canPreventDefault: true,
            });
            if (!active && !event.defaultPrevented) {
              navigation.navigate(route.name);
            }
          };
          return (
            <Pressable
              key={tab.routeName}
              accessibilityRole="button"
              accessibilityState={active ? { selected: true } : {}}
              onPress={onPress}
              style={[
                styles.item,
                {
                  backgroundColor: active ? tokens.ink : "transparent",
                },
              ]}
            >
              <Icon
                name={tab.icon}
                size={16}
                color={active ? tokens.surface : tokens.ink2}
              />
              <Text
                style={[
                  styles.label,
                  { color: active ? tokens.surface : tokens.ink2 },
                ]}
              >
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </BlurView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: 12,
    right: 12,
    zIndex: 70,
  },
  bar: {
    flexDirection: "row",
    gap: 4,
    padding: 4,
    borderRadius: 28,
    borderWidth: 1,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  item: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  label: {
    fontSize: 10,
    fontWeight: "500",
    letterSpacing: 0.2,
  },
});
