/**
 * RecordingOverlay — live waveform displayed above the RecordingStrip
 * while a voice memo recording is in progress.
 *
 * Reuses the waveform bar geometry from AudioMessage.tsx (WAVEFORM_*
 * constants) so the live preview and the played-back bubble look identical.
 * No transcript; pure amplitude bars.
 *
 * Bars flow continuously: the bucketer's snapshot() is a sliding window of
 * the last 80 raw samples. New samples land on the right, oldest drop off
 * the left — same visual model as WhatsApp's recording overlay. During the
 * first ~4s of recording (before the window fills), empty bars pad the LEFT
 * so what little has been captured is right-aligned and grows naturally
 * toward the left as recording continues.
 *
 * Slides in from above (translateY: -80 → 0) on mount.
 */

import React, { useEffect, useRef } from "react";
import { View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useThemeTokens } from "@/components/ui/tokens";

// ---------------------------------------------------------------------------
// Waveform geometry — must match AudioMessage.tsx constants
// ---------------------------------------------------------------------------

const WAVEFORM_BAR_COUNT = 80;
const WAVEFORM_BAR_WIDTH = 2; // slightly wider for live overlay (more visible)
const WAVEFORM_GAP = 1;
const WAVEFORM_MAX_HEIGHT = 28;
const WAVEFORM_MIN_HEIGHT = 2;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface RecordingOverlayProps {
  /** Live peak snapshot from PeakBucketer.snapshot() — up to 80 values in 0..1. */
  livePeaks: number[];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Full-width live waveform overlay rendered above the recording strip.
 *
 * @param livePeaks - Current bucketer snapshot, updated at ~10 fps by parent.
 */
export function RecordingOverlay({
  livePeaks,
}: RecordingOverlayProps): React.ReactElement {
  const tokens = useThemeTokens();

  // Slide down from above on mount.
  const translateY = useSharedValue(-80);
  const mountedRef = useRef(false);

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      translateY.value = withTiming(0, {
        duration: 200,
        easing: Easing.out(Easing.ease),
      });
    }
  }, [translateY]);

  const slideStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
    opacity: translateY.value === -80 ? 0 : 1,
  }));

  // Pad livePeaks to WAVEFORM_BAR_COUNT with min-height at the LEFT so bars
  // appear to grow in from the right edge.
  const displayPeaks: number[] = [];
  const padding = WAVEFORM_BAR_COUNT - livePeaks.length;
  for (let i = 0; i < padding; i++) {
    displayPeaks.push(0); // silent / empty bar on the left
  }
  for (const p of livePeaks) {
    displayPeaks.push(p);
  }

  return (
    <Animated.View
      style={[
        {
          paddingHorizontal: 12,
          paddingVertical: 8,
          backgroundColor: tokens.surface,
          borderTopWidth: 1,
          borderTopColor: tokens.line,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
        },
        slideStyle,
      ]}
      pointerEvents="none"
    >
      {displayPeaks.map((p, i) => {
        const height = Math.max(WAVEFORM_MIN_HEIGHT, p * WAVEFORM_MAX_HEIGHT);
        const isActive = i >= padding; // right-side bars are real data
        return (
          <View
            key={i}
            style={{
              width: WAVEFORM_BAR_WIDTH,
              height,
              borderRadius: 1,
              backgroundColor: isActive ? tokens.danger : tokens.line,
              marginRight: i < WAVEFORM_BAR_COUNT - 1 ? WAVEFORM_GAP : 0,
              alignSelf: "center",
            }}
          />
        );
      })}
    </Animated.View>
  );
}
