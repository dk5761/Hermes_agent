/**
 * RecordingStrip — replaces the composer input row during recording.
 *
 * Layout:
 *   ● 0:14    ← Slide to cancel
 *
 * - Left: pulsing red dot + M:SS timer
 * - Center: "← Slide to cancel" hint (italic). When state==="cancelling" the
 *   hint turns red and reads "Release to cancel".
 * - Right: nothing. The mic button itself is the action — tap to commit
 *   (tap-toggle / locked-hold), release to commit (hold-active).
 *
 * Slides in from the left on mount, slides out to the left on unmount.
 */

import React, { useEffect, useRef } from "react";
import { Text, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useThemeTokens } from "@/components/ui/tokens";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RecordingMode =
  | "tap-toggle"
  | "hold-active"
  | "locked-hold"
  | "cancelling";

export interface RecordingStripProps {
  /** Current recording mode — drives hint text. */
  state: RecordingMode;
  /** Elapsed recording time in milliseconds, updated by parent every 100ms. */
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format milliseconds as "M:SS". */
function fmtMs(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Recording strip — slides in from the left, replacing the composer input.
 *
 * @param state      - Current recording mode.
 * @param elapsedMs  - Elapsed milliseconds, updated by parent.
 */
export function RecordingStrip({
  state,
  elapsedMs,
}: RecordingStripProps): React.ReactElement {
  const tokens = useThemeTokens();

  // Slide in from the left on mount (-400 → 0), slide out on unmount (0 → -400).
  const translateX = useSharedValue(-400);
  const mountedRef = useRef(false);

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      translateX.value = withTiming(0, {
        duration: 200,
        easing: Easing.out(Easing.ease),
      });
    }
  }, [translateX]);

  const slideStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const isCancelling = state === "cancelling";

  const hintText = isCancelling ? "Release to cancel" : "← Slide to cancel";
  const hintColor = isCancelling ? tokens.danger : tokens.ink3;

  return (
    <Animated.View
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          flex: 1,
          paddingHorizontal: 8,
          paddingVertical: 6,
          borderRadius: 22,
          borderWidth: isCancelling ? 1.5 : 0,
          borderColor: isCancelling ? tokens.danger : "transparent",
          backgroundColor: tokens.surface,
        },
        slideStyle,
      ]}
    >
      {/* Pulsing red dot */}
      <View
        style={{
          width: 10,
          height: 10,
          borderRadius: 5,
          backgroundColor: tokens.danger,
          marginRight: 8,
          flexShrink: 0,
        }}
      />

      {/* Timer */}
      <Text
        style={{
          color: tokens.ink,
          fontSize: 15,
          fontVariant: ["tabular-nums"],
          marginRight: 12,
          flexShrink: 0,
        }}
      >
        {fmtMs(elapsedMs)}
      </Text>

      {/* Hint — fills available space */}
      <Text
        style={{
          color: hintColor,
          fontSize: 13,
          fontStyle: isCancelling ? "normal" : "italic",
          flex: 1,
        }}
        numberOfLines={1}
      >
        {hintText}
      </Text>

      {/* No send button — the mic button itself is the action. Tap the
          mic in tap-toggle / locked-hold modes to commit; release the
          mic in hold-active mode. */}
    </Animated.View>
  );
}
