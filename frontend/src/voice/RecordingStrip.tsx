/**
 * RecordingStrip — replaces the composer input row during recording.
 *
 * Layout:
 *   ● 0:14    ← Slide to cancel                           ✓
 *
 * - Left: pulsing red dot + M:SS timer
 * - Center: "← Slide to cancel" hint (italic). When state==="cancelling" the
 *   hint turns red and reads "Release to cancel".
 * - Right: checkmark send button — only visible in tap-toggle or locked-hold
 *   states. In hold-active the finger is on screen, so release is the action;
 *   no button needed.
 *
 * Slides in from the left on mount, slides out to the left on unmount.
 */

import React, { useEffect, useRef } from "react";
import {
  Pressable,
  Text,
  View,
} from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle, Path } from "react-native-svg";
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
  /** Current recording mode — drives hint text + button visibility. */
  state: RecordingMode;
  /** Elapsed recording time in milliseconds, updated by parent every 100ms. */
  elapsedMs: number;
  /** Called when user taps the send checkmark (tap-toggle / locked-hold). */
  onSend?: () => void;
  /** Called when user taps cancel (only relevant if we add a cancel button). */
  onCancel?: () => void;
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
// Sub-components
// ---------------------------------------------------------------------------

/** Send/confirm checkmark icon. */
function SendIcon({ color, size }: { color: string; size: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M5 13l4 4L19 7"
        stroke={color}
        strokeWidth={2.5}
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
 * Recording strip — slides in from the left, replacing the composer input.
 *
 * @param state      - Current recording mode.
 * @param elapsedMs  - Elapsed milliseconds, updated by parent.
 * @param onSend     - Commit callback (visible in tap-toggle + locked-hold).
 * @param onCancel   - Cancel callback (unused currently; cancel is gesture-driven).
 */
export function RecordingStrip({
  state,
  elapsedMs,
  onSend,
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
  const showSendButton = state === "tap-toggle" || state === "locked-hold";

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

      {/* Send button — only in tap-toggle / locked-hold */}
      {showSendButton ? (
        <Pressable
          onPress={onSend}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Send voice memo"
          style={({ pressed }) => ({
            width: 32,
            height: 32,
            borderRadius: 16,
            backgroundColor: tokens.ink,
            alignItems: "center",
            justifyContent: "center",
            opacity: pressed ? 0.7 : 1,
            marginLeft: 8,
            flexShrink: 0,
          })}
        >
          <SendIcon color={tokens.surface} size={18} />
        </Pressable>
      ) : (
        // Reserve space so the layout doesn't shift when button appears.
        <View style={{ width: 40, flexShrink: 0 }} />
      )}
    </Animated.View>
  );
}
