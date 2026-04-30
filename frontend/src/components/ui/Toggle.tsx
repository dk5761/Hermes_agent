/**
 * Toggle — animated 44x26 switch (matches ui.jsx::Toggle).
 *
 * Uses Reanimated shared values so the thumb translation runs on the UI
 * thread. Track + thumb colors come from the theme tokens at runtime
 * because Tailwind classes can't accept dynamic conditional swaps cleanly.
 */
import React, { useEffect } from "react";
import { Pressable, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useTheme } from "@/theme";
import { useThemeTokens } from "./tokens";

export interface ToggleProps {
  on: boolean;
  onChange?: (next: boolean) => void;
}

export function Toggle({ on, onChange }: ToggleProps) {
  const { mode } = useTheme();
  const tokens = useThemeTokens();
  const progress = useSharedValue(on ? 1 : 0);

  useEffect(() => {
    progress.value = withTiming(on ? 1 : 0, { duration: 160 });
  }, [on, progress]);

  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: progress.value * 18 }],
  }));

  // Track background color depends on `on` and theme mode (matches ui.jsx).
  const trackBg = on
    ? tokens.accent
    : mode === "dark"
      ? tokens.line
      : tokens.sunken;
  const trackBorder = on ? tokens.accent : tokens.line;

  return (
    <Pressable
      onPress={() => onChange?.(!on)}
      style={{
        width: 44,
        height: 26,
        padding: 2,
        borderRadius: 999,
        backgroundColor: trackBg,
        borderWidth: 1,
        borderColor: trackBorder,
      }}
    >
      <Animated.View
        style={[
          {
            width: 20,
            height: 20,
            borderRadius: 10,
            backgroundColor: tokens.surface,
            // Subtle shadow so the thumb is visible on dark tracks.
            shadowColor: "#000",
            shadowOpacity: 0.15,
            shadowRadius: 2,
            shadowOffset: { width: 0, height: 1 },
            elevation: 2,
          },
          thumbStyle,
        ]}
      >
        {/* Empty inner View keeps Animated.View happy under iOS 18. */}
        <View />
      </Animated.View>
    </Pressable>
  );
}
