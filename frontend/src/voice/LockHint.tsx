/**
 * LockHint — floating chip shown above the mic button during hold-active mode.
 *
 * Fades in + translates upward when visible. Disappears (fades out) when the
 * user drags up past the lock threshold (transitioning to locked-hold, at which
 * point the mic icon transforms into a stop button).
 *
 * Rendered by MicButton, positioned absolute above the button itself.
 */

import React, { useEffect } from "react";
import { View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import Svg, { Path, Rect } from "react-native-svg";
import { useThemeTokens } from "@/components/ui/tokens";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface LockHintProps {
  /** Whether to show the hint. */
  visible: boolean;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Simple lock icon (outline). */
function LockIcon({ color, size }: { color: string; size: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect
        x="5"
        y="11"
        width="14"
        height="10"
        rx="2"
        stroke={color}
        strokeWidth={2}
      />
      <Path
        d="M8 11V7a4 4 0 018 0v4"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Small upward-pointing chevron / arrow. */
function UpArrow({ color }: { color: string }) {
  return (
    <Svg width={12} height={8} viewBox="0 0 12 8" fill="none">
      <Path
        d="M1 7l5-5 5 5"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Animated lock hint chip shown above the mic button in hold-active state.
 *
 * @param visible - Whether the hint is shown. Animates in/out smoothly.
 */
export function LockHint({ visible }: LockHintProps): React.ReactElement {
  const tokens = useThemeTokens();

  const opacity = useSharedValue(0);
  const translateY = useSharedValue(10);

  useEffect(() => {
    if (visible) {
      opacity.value = withTiming(1, { duration: 200, easing: Easing.out(Easing.ease) });
      translateY.value = withTiming(0, { duration: 200, easing: Easing.out(Easing.ease) });
    } else {
      opacity.value = withTiming(0, { duration: 150, easing: Easing.in(Easing.ease) });
      translateY.value = withTiming(10, { duration: 150, easing: Easing.in(Easing.ease) });
    }
  }, [visible, opacity, translateY]);

  const animStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  return (
    <Animated.View
      style={[
        {
          // Absolute chip floating above the mic button; caller positions it.
          alignItems: "center",
          pointerEvents: "none" as const,
        },
        animStyle,
      ]}
      pointerEvents="none"
    >
      {/* Lock chip */}
      <View
        style={{
          paddingHorizontal: 10,
          paddingVertical: 8,
          borderRadius: 14,
          backgroundColor: tokens.surface,
          borderWidth: 1,
          borderColor: tokens.line,
          alignItems: "center",
          shadowColor: "#000",
          shadowOpacity: 0.1,
          shadowRadius: 4,
          shadowOffset: { width: 0, height: 2 },
          elevation: 3,
        }}
      >
        <LockIcon color={tokens.ink2} size={20} />
      </View>

      {/* Upward arrow hint underneath the chip */}
      <View style={{ marginTop: 4 }}>
        <UpArrow color={tokens.ink3} />
      </View>
    </Animated.View>
  );
}
