/**
 * ProgressBar — h=4 track with animated fill (matches ui.jsx::ProgressBar).
 *
 * Uses Reanimated to animate the fill width over 240ms. `value` is clamped
 * to [0, 1].
 */
import React, { useEffect } from "react";
import { View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useThemeTokens } from "./tokens";

export interface ProgressBarProps {
  value?: number;
  /** Optional fill color override (hex). Defaults to theme accent. */
  color?: string;
}

export function ProgressBar({ value = 0, color }: ProgressBarProps) {
  const tokens = useThemeTokens();
  const clamped = Math.max(0, Math.min(1, value));
  const progress = useSharedValue(clamped);

  useEffect(() => {
    progress.value = withTiming(clamped, { duration: 240 });
  }, [clamped, progress]);

  const fillStyle = useAnimatedStyle(() => ({
    width: `${progress.value * 100}%`,
  }));

  return (
    <View
      className="bg-line-soft"
      style={{ height: 4, borderRadius: 2, overflow: "hidden" }}
    >
      <Animated.View
        style={[
          {
            height: "100%",
            backgroundColor: color ?? tokens.accent,
          },
          fillStyle,
        ]}
      />
    </View>
  );
}
