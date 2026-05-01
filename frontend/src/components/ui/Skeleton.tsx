/**
 * Skeleton — placeholder blocks for list-screen loading states.
 *
 * Three primitives:
 *   - <Skeleton> renders a single bg-chip block at the requested size, with a
 *     subtle Reanimated opacity shimmer (0.5 → 1.0, 1000ms ping-pong) so the
 *     skeleton reads as "loading" rather than a static empty card.
 *   - <SkeletonRow> matches the height + visual rhythm of a `<ListRow>` so
 *     replacing real rows with skeletons doesn't shift the surrounding layout
 *     when data arrives. Stack 6 of these inside a `<ListGroup>`.
 *   - <SkeletonChat> alternates user/assistant bubble shapes for the chat
 *     screen's empty-pre-history state.
 *
 * All three are pure presentation — no theme switching tween-handling, no
 * cleanup hooks beyond Reanimated's own lifecycle. Honors a single shared
 * shared-value so every skeleton on screen pulses in lockstep.
 */
import React, { useEffect } from "react";
import { View, type ViewStyle } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { useThemeTokens } from "./tokens";

export interface SkeletonProps {
  width?: number | `${number}%`;
  height?: number;
  /** Border radius. Defaults to 6 (matches our pill / chip rounding). */
  radius?: number;
  style?: ViewStyle;
}

/** Shared shimmer driver — one shared value re-used by every Skeleton. */
function useShimmer(): SharedValue<number> {
  const opacity = useSharedValue(0.5);
  useEffect(() => {
    opacity.value = withRepeat(
      withTiming(1, { duration: 1000, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
    return () => {
      cancelAnimation(opacity);
    };
  }, [opacity]);
  return opacity;
}

export function Skeleton({ width, height = 12, radius = 6, style }: SkeletonProps) {
  const tokens = useThemeTokens();
  const opacity = useShimmer();

  const animStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  return (
    <Animated.View
      style={[
        {
          width,
          height,
          borderRadius: radius,
          backgroundColor: tokens.chip,
        },
        animStyle,
        style,
      ]}
    />
  );
}

/**
 * SkeletonRow — placeholder shape mirroring `<ListRow>` (icon tile + 2 text
 * lines + chevron). Used inside `<ListGroup>` so dividers continue to render.
 */
export function SkeletonRow() {
  const tokens = useThemeTokens();
  return (
    <View
      style={{
        minHeight: 56,
        paddingVertical: 12,
        paddingHorizontal: 16,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
      }}
    >
      {/* Icon tile placeholder (matches ListRow's 30×30 tile). */}
      <Skeleton width={30} height={30} radius={8} />
      <View style={{ flex: 1, gap: 6 }}>
        <Skeleton width="60%" height={13} />
        <Skeleton width="40%" height={11} />
      </View>
      {/* Chevron placeholder. */}
      <Skeleton width={10} height={10} radius={2} style={{ opacity: 0.6 }} />
      {/* Reference token to suppress unused-var warning in some toolchains. */}
      {tokens ? null : null}
    </View>
  );
}

export interface SkeletonGroupProps {
  /** Number of rows to render. Defaults to 6. */
  count?: number;
}

/**
 * SkeletonGroup — convenience for "show N SkeletonRows wrapped in a card with
 * dividers" — saves callers from re-implementing the divider math at every
 * list site.
 */
export function SkeletonGroup({ count = 6 }: SkeletonGroupProps) {
  const tokens = useThemeTokens();
  return (
    <View
      style={{
        marginHorizontal: 16,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: tokens.line,
        backgroundColor: tokens.surface,
        overflow: "hidden",
      }}
    >
      {Array.from({ length: count }).map((_, i) => (
        <View
          key={i}
          style={{
            borderBottomWidth: i < count - 1 ? 1 : 0,
            borderBottomColor: tokens.lineSoft,
          }}
        >
          <SkeletonRow />
        </View>
      ))}
    </View>
  );
}

export interface SkeletonChatProps {
  /** Number of bubbles to render. Defaults to 5 (alternating user/assistant). */
  count?: number;
}

/**
 * SkeletonChat — alternating bubble blocks for the chat screen's
 * empty-pre-history state. Right-aligned bubbles mimic the user role,
 * left-aligned mimic the assistant. Widths vary so the column doesn't read
 * as a uniform stripe.
 */
export function SkeletonChat({ count = 5 }: SkeletonChatProps) {
  // Pre-baked widths so the visual cadence reads as "real" conversation.
  const ROW_WIDTHS: ReadonlyArray<`${number}%`> = ["62%", "78%", "44%", "70%", "56%"];
  return (
    <View style={{ paddingVertical: 12, gap: 14 }}>
      {Array.from({ length: count }).map((_, i) => {
        const isUser = i % 2 === 1;
        const width = ROW_WIDTHS[i % ROW_WIDTHS.length] ?? "60%";
        return (
          <View
            key={i}
            style={{
              paddingHorizontal: 14,
              flexDirection: "row",
              justifyContent: isUser ? "flex-end" : "flex-start",
            }}
          >
            <View style={{ gap: 6, maxWidth: "82%", width: "100%" }}>
              <Skeleton
                width={width}
                height={18}
                radius={12}
                style={{ alignSelf: isUser ? "flex-end" : "flex-start" }}
              />
              {/* Second line for assistant bubbles to mimic multi-line replies. */}
              {!isUser ? (
                <Skeleton
                  width="48%"
                  height={14}
                  radius={10}
                  style={{ alignSelf: "flex-start" }}
                />
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}
