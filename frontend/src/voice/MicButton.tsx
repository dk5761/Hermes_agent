/**
 * MicButton — PTT (default) or tap-to-toggle mic button for the chat composer.
 *
 * Visual states:
 *   idle      → outlined mic icon, neutral (ink3) tint, surface background
 *   recording → filled mic icon, danger tint, expanding pulse ring behind it
 *               (ring is suppressed when OS prefers reduced motion; a static
 *               REC dot is shown instead)
 *   error     → shake animation (~300ms, ±4pt), danger tint, auto-reverts to
 *               idle after 2s
 *   disabled  → 40% opacity, non-interactive
 *
 * Model-state overlays (WhisperKit):
 *   absent     → small download-arrow badge on the button; long-press starts download
 *   downloading → animated progress ring around the button; tap is disabled
 *   failed     → red X badge; tap retries ensureModelReady()
 *   ready      → no overlay; normal behaviour
 *
 * Slide-to-cancel (PTT only):
 *   We use plain Pressable onPressIn / onPressOut and track the touch position
 *   via onLayout (to get button bounds) plus a pan handler implemented with
 *   Pressable's onMoveCapture prop via RN's Responder system.
 *   Concretely: we capture the initial touch via onPressIn, then use the
 *   ViewResponder callbacks (onStartShouldSetResponder + onResponderMove) on
 *   an outer View to detect when the finger leaves the button area. When the
 *   Y offset moves more than CANCEL_THRESHOLD_PT above the button's top edge
 *   we set a cancelRef flag so onPressOut calls cancel() instead of stop().
 *
 *   Why this approach rather than react-native-gesture-handler (RNGH)?
 *   RNGH is in package.json but is used as Expo Router's gesture provider, not
 *   imported directly by any UI component in this codebase. Introducing RNGH's
 *   Gesture API in the first component that uses it would be a pattern
 *   divergence. The plain Responder approach keeps MicButton self-contained,
 *   avoids wrapping the button in a GestureDetector, and is sufficient for the
 *   single gesture we need.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  type LayoutChangeEvent,
  type GestureResponderEvent,
  Pressable,
  View,
} from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import Svg, { Circle, Path } from "react-native-svg";

import { useThemeTokens } from "@/components/ui/tokens";
import { useVoiceInput } from "./useVoiceInput";
import type { VoiceInputError } from "./useVoiceInput";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum tap-target size per iOS HIG. */
const DEFAULT_SIZE = 44;

/**
 * How far (in points) the finger must travel upward above the button's top
 * edge before the press is treated as a cancel gesture.
 */
const CANCEL_THRESHOLD_PT = 20;

/** Duration of the error-shake animation in ms (3 oscillations × 100ms each). */
const SHAKE_DURATION_MS = 100;

/** How long the error visual state is shown before auto-reverting to idle. */
const ERROR_DISPLAY_MS = 2000;

// ---------------------------------------------------------------------------
// SVG icon paths
// ---------------------------------------------------------------------------

/** Outlined mic — used in idle state. Matches ICONS.mic from Icon.tsx */
const MIC_OUTLINE_PATH =
  "M12 2a3 3 0 00-3 3v6a3 3 0 006 0V5a3 3 0 00-3-3zM5 11a7 7 0 0014 0M12 18v3";

/**
 * Filled mic — used in recording state. Same outer shape with a filled body
 * so it reads as "active". We draw a filled rect + the outline strokes.
 * Since the Icon system draws stroke-only paths, we render this inline with
 * react-native-svg so we can mix fill + stroke on separate layers.
 */

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Outlined mic SVG (idle / error states). */
function MicOutline({ size, color, stroke = 1.6 }: { size: number; color: string; stroke?: number }) {
  const segments = MIC_OUTLINE_PATH.split("M").filter(Boolean);
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {segments.map((seg, i) => (
        <Path key={i} d={"M" + seg} />
      ))}
    </Svg>
  );
}

/** Filled mic SVG (recording state). */
function MicFilled({ size, color }: { size: number; color: string }) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* Filled body of the microphone capsule */}
      <Path
        d="M12 2a3 3 0 00-3 3v6a3 3 0 006 0V5a3 3 0 00-3-3z"
        fill={color}
        stroke={color}
        strokeWidth={1.6}
      />
      {/* Stand arc + stem */}
      <Path
        d="M5 11a7 7 0 0014 0M12 18v3"
        stroke={color}
        strokeWidth={1.6}
      />
    </Svg>
  );
}

/** Small "REC" dot for reduced-motion recording state. */
function RecDot({ color }: { color: string }) {
  return (
    <Svg
      width={8}
      height={8}
      viewBox="0 0 8 8"
      style={{ position: "absolute", top: 2, right: 2 }}
    >
      <Circle cx="4" cy="4" r="4" fill={color} />
    </Svg>
  );
}

/**
 * Download-arrow badge (model absent).
 * Small filled down-arrow in the bottom-right corner of the button.
 */
function DownloadBadge({ color, bg }: { color: string; bg: string }) {
  return (
    <View
      style={{
        position: "absolute",
        bottom: -2,
        right: -2,
        width: 12,
        height: 12,
        borderRadius: 6,
        backgroundColor: bg,
        alignItems: "center",
        justifyContent: "center",
      }}
      pointerEvents="none"
    >
      <Svg width={8} height={8} viewBox="0 0 24 24" fill="none">
        <Path
          d="M12 3v13M5 12l7 7 7-7"
          stroke={color}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    </View>
  );
}

/**
 * Error-X badge (model download failed).
 * Small red filled circle with an X in the bottom-right corner.
 */
function ErrorBadge({ dangerColor }: { dangerColor: string }) {
  return (
    <View
      style={{
        position: "absolute",
        bottom: -2,
        right: -2,
        width: 12,
        height: 12,
        borderRadius: 6,
        backgroundColor: dangerColor,
        alignItems: "center",
        justifyContent: "center",
      }}
      pointerEvents="none"
    >
      <Svg width={7} height={7} viewBox="0 0 24 24" fill="none">
        <Path
          d="M18 6L6 18M6 6l12 12"
          stroke="#fff"
          strokeWidth={3}
          strokeLinecap="round"
        />
      </Svg>
    </View>
  );
}

/**
 * Circular progress ring that wraps the button during model download.
 * Uses SVG stroke-dashoffset technique.
 */
function ProgressRing({
  size,
  progress,
  color,
}: {
  size: number;
  progress: number;
  color: string;
}) {
  const r = size / 2 - 2;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - Math.min(1, Math.max(0, progress)));
  return (
    <Svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{ position: "absolute" }}
      pointerEvents="none"
    >
      {/* Track */}
      <Circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke={color}
        strokeWidth={2}
        opacity={0.2}
        fill="none"
      />
      {/* Fill arc — rotated so it starts at the top */}
      <Circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke={color}
        strokeWidth={2}
        fill="none"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform={`rotate(-90, ${size / 2}, ${size / 2})`}
      />
    </Svg>
  );
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MicButtonProps {
  /** Final transcript handler. Called when user releases (PTT) or stops (toggle). */
  onTranscript: (text: string) => void;
  /**
   * Fires every time a new confirmed segment arrives during recording with the
   * full accumulated transcript for that session. Allows incremental append to
   * the composer's input value without waiting for the final stop.
   */
  onTranscriptChange?: (fullTranscript: string) => void;
  /**
   * Called once at the very start of each recording session (when state enters
   * "recording"). Use to snapshot composer base-input for the append flow.
   */
  onRecordingStart?: () => void;
  /** Live partial transcript while recording. Optional — used for inline preview. */
  onPartial?: (text: string) => void;
  /** Error callback (permission denied, mic unavailable, etc.). */
  onError?: (err: VoiceInputError) => void;
  /** Disable the button (e.g., while agent is streaming). */
  disabled?: boolean;
  /** Interaction mode. Default "ptt". */
  mode?: "ptt" | "toggle";
  /** Override the language. Default = device locale. */
  language?: string;
  /** Apple's auto-punctuation. Default true. */
  addsPunctuation?: boolean;
  /** Optional size in points. Default 44 (iOS HIG min tap target). */
  size?: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type VisualState = "idle" | "recording" | "error";

export function MicButton({
  onTranscript,
  onTranscriptChange,
  onRecordingStart,
  onPartial,
  onError,
  disabled = false,
  mode = "ptt",
  language,
  addsPunctuation = true,
  size = DEFAULT_SIZE,
}: MicButtonProps): React.ReactElement {
  const tokens = useThemeTokens();
  const reducedMotion = useReducedMotion();

  // -------------------------------------------------------------------------
  // Voice hook
  // -------------------------------------------------------------------------

  const voice = useVoiceInput({
    language,
    addsPunctuation,
    onFinalTranscript: onTranscript,
  });

  // -------------------------------------------------------------------------
  // Local visual state (separate from voice.state so error display lingers)
  // -------------------------------------------------------------------------

  const [visualState, setVisualState] = useState<VisualState>("idle");

  // Track whether we've already fired onRecordingStart for the current session.
  const recordingStartFiredRef = useRef<boolean>(false);

  // Sync recording / error transitions from the hook's state machine.
  useEffect(() => {
    const k = voice.state.kind;
    if (k === "recording") {
      setVisualState("recording");
      if (!recordingStartFiredRef.current) {
        recordingStartFiredRef.current = true;
        onRecordingStart?.();
      }
    } else if (k === "error") {
      recordingStartFiredRef.current = false;
      setVisualState("error");
      const t = setTimeout(() => setVisualState("idle"), ERROR_DISPLAY_MS);
      return () => clearTimeout(t);
    } else if (k === "idle" || k === "stopping") {
      // Don't immediately clear recording visual until idle — lets the user see
      // the button held-active through the stopping transition.
      if (k === "idle") {
        recordingStartFiredRef.current = false;
        setVisualState("idle");
      }
    }
    return undefined;
  }, [voice.state, onRecordingStart]);

  // Surface error to caller whenever the hook enters error state.
  useEffect(() => {
    if (voice.state.kind === "error") {
      onError?.(voice.state.error);
    }
  }, [voice.state, onError]);

  // Forward partials from recording state.
  useEffect(() => {
    if (voice.state.kind === "recording") {
      onPartial?.(voice.state.partialTranscript);
    }
  }, [voice.state, onPartial]);

  // Emit incremental transcript changes so the composer can do live append.
  // Track previous transcript to emit only on actual changes.
  const prevTranscriptRef = useRef<string>("");
  useEffect(() => {
    if (voice.transcript !== prevTranscriptRef.current) {
      prevTranscriptRef.current = voice.transcript;
      // Only fire while a session is active to avoid emitting on reset().
      if (voice.isListening && voice.transcript.length > 0) {
        onTranscriptChange?.(voice.transcript);
      }
    }
  }, [voice.transcript, voice.isListening, onTranscriptChange]);

  // -------------------------------------------------------------------------
  // PTT slide-to-cancel tracking
  // -------------------------------------------------------------------------

  /**
   * Holds the Y coordinate of the button's top edge in screen coordinates.
   * Populated by the onLayout callback on the outer wrapper.
   */
  const buttonTopRef = useRef<number>(0);
  const cancelOnReleaseRef = useRef<boolean>(false);

  const handleLayout = useCallback((e: LayoutChangeEvent) => {
    // Measure to get the screen-absolute Y of the button top. We use the
    // layout's y and height to calculate where "above the button" begins.
    const { y } = e.nativeEvent.layout;
    buttonTopRef.current = y;
  }, []);

  const handleResponderMove = useCallback(
    (e: GestureResponderEvent) => {
      if (mode !== "ptt") return;
      const touchY = e.nativeEvent.pageY;
      // Cancel if finger is more than CANCEL_THRESHOLD_PT above the button top.
      if (touchY < buttonTopRef.current - CANCEL_THRESHOLD_PT) {
        cancelOnReleaseRef.current = true;
      }
    },
    [mode]
  );

  // -------------------------------------------------------------------------
  // Animations — pulse ring
  // -------------------------------------------------------------------------

  const pulseScale = useSharedValue(1);
  const pulseOpacity = useSharedValue(0);

  useEffect(() => {
    if (visualState === "recording" && !reducedMotion) {
      pulseScale.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 0 }),
          withTiming(1.8, { duration: 1200, easing: Easing.out(Easing.ease) })
        ),
        -1,
        false
      );
      pulseOpacity.value = withRepeat(
        withSequence(
          withTiming(0.5, { duration: 0 }),
          withTiming(0, { duration: 1200, easing: Easing.out(Easing.ease) })
        ),
        -1,
        false
      );
    } else {
      cancelAnimation(pulseScale);
      cancelAnimation(pulseOpacity);
      pulseScale.value = withTiming(1, { duration: 150 });
      pulseOpacity.value = withTiming(0, { duration: 150 });
    }
  }, [visualState, reducedMotion, pulseScale, pulseOpacity]);

  const pulseStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulseScale.value }],
    opacity: pulseOpacity.value,
  }));

  // -------------------------------------------------------------------------
  // Animations — error shake
  // -------------------------------------------------------------------------

  const shakeX = useSharedValue(0);

  useEffect(() => {
    if (visualState === "error") {
      shakeX.value = withSequence(
        withTiming(4, { duration: SHAKE_DURATION_MS }),
        withTiming(-4, { duration: SHAKE_DURATION_MS }),
        withTiming(4, { duration: SHAKE_DURATION_MS }),
        withTiming(-4, { duration: SHAKE_DURATION_MS }),
        withTiming(0, { duration: SHAKE_DURATION_MS })
      );
    }
  }, [visualState, shakeX]);

  const shakeStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: shakeX.value }],
  }));

  // -------------------------------------------------------------------------
  // Colors derived from visual state + theme tokens
  // -------------------------------------------------------------------------

  const iconColor =
    visualState === "idle"
      ? tokens.ink3
      : visualState === "recording"
        ? tokens.danger
        : tokens.danger;

  const borderColor =
    visualState === "idle"
      ? tokens.line
      : visualState === "recording"
        ? tokens.danger
        : tokens.danger;

  const bgColor =
    visualState === "recording" ? tokens.accentBg : tokens.surface;

  // -------------------------------------------------------------------------
  // Model-state derived values
  // -------------------------------------------------------------------------

  const modelStatus = voice.modelStatus;
  const modelProgress = voice.modelProgress;

  // Tap is disabled when the model is downloading (long-press to cancel would
  // be idempotent; just block taps to avoid confusing state transitions).
  const tapDisabled = disabled || modelStatus === "downloading";

  // -------------------------------------------------------------------------
  // PTT press handlers
  // -------------------------------------------------------------------------

  const handlePressIn = useCallback(() => {
    if (tapDisabled) return;
    if (mode !== "ptt") return;
    // When model is absent: long-press starts download; regular press-in is
    // a short tap that should be ignored (downloading is the right CTA).
    if (modelStatus !== "ready" && modelStatus !== "absent") return;
    cancelOnReleaseRef.current = false;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    void voice.start().catch(() => {
      // start() throws model_not_ready if model isn't ready — handled by the
      // error effect above which surfaces it to onError. No extra handling here.
    });
  }, [tapDisabled, mode, modelStatus, voice]);

  const handlePressOut = useCallback(() => {
    if (tapDisabled) return;
    if (mode !== "ptt") return;
    if (cancelOnReleaseRef.current) {
      cancelOnReleaseRef.current = false;
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft).catch(() => undefined);
      voice.cancel();
    } else {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
      void voice.stop();
    }
  }, [tapDisabled, mode, voice]);

  // -------------------------------------------------------------------------
  // Toggle press handler
  // -------------------------------------------------------------------------

  const handlePress = useCallback(() => {
    if (mode !== "toggle") return;

    // Model failed — tap retries the download.
    if (modelStatus === "failed") {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
      void voice.ensureModelReady().catch(() => {
        // error forwarded via onError through the effect above
      });
      return;
    }

    // Model absent — tap is not the right affordance; long-press starts download.
    // Provide a light haptic to signal the model needs downloading.
    if (modelStatus !== "ready") return;

    if (disabled) return;
    const k = voice.state.kind;
    if (k === "idle" || k === "error") {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
      void voice.start().catch(() => undefined);
    } else if (k === "recording" || k === "stopping" || k === "requesting_permission") {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
      void voice.stop();
    }
  }, [disabled, mode, modelStatus, voice]);

  // -------------------------------------------------------------------------
  // Long-press handler — triggers model download when not ready
  // -------------------------------------------------------------------------

  const handleLongPress = useCallback(() => {
    // During download or when ready, long-press is a no-op.
    if (modelStatus === "downloading" || modelStatus === "ready") return;

    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    void voice.ensureModelReady().catch(() => {
      // error forwarded via onError through the effect above
    });
  }, [modelStatus, voice]);

  // Fire a haptic + error notification whenever an error surfaces.
  useEffect(() => {
    if (visualState === "error") {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(
        () => undefined
      );
    }
  }, [visualState]);

  // -------------------------------------------------------------------------
  // Accessibility
  // -------------------------------------------------------------------------

  const a11yLabel = (() => {
    if (modelStatus === "absent") return "Voice input. Hold to download voice model.";
    if (modelStatus === "downloading") return `Voice model downloading, ${Math.round(modelProgress * 100)}%`;
    if (modelStatus === "failed") return "Voice model download failed. Tap to retry.";
    if (mode === "ptt") return "Voice input. Hold to record.";
    return visualState === "recording"
      ? "Voice input. Tap to stop recording."
      : "Voice input. Tap to start recording.";
  })();

  const a11yHint =
    mode === "ptt" && modelStatus === "ready"
      ? "Slide finger up while holding to cancel."
      : modelStatus === "absent"
        ? "Hold to download the voice model."
        : undefined;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const iconSize = Math.round(size * 0.5);
  const pulseSize = size * 1.6;
  // Progress ring is slightly larger than the button circle.
  const ringSize = size + 8;

  return (
    <View
      onLayout={handleLayout}
      onStartShouldSetResponder={() => mode === "ptt"}
      onResponderMove={handleResponderMove}
      style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}
    >
      {/* Pulse ring — rendered behind the button (recording state only) */}
      {!reducedMotion && (
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: "absolute",
              width: pulseSize,
              height: pulseSize,
              borderRadius: pulseSize / 2,
              backgroundColor: tokens.danger,
            },
            pulseStyle,
          ]}
        />
      )}

      {/* Model download progress ring */}
      {modelStatus === "downloading" ? (
        <View
          pointerEvents="none"
          style={{ position: "absolute", width: ringSize, height: ringSize }}
        >
          <ProgressRing
            size={ringSize}
            progress={modelProgress}
            color={tokens.accent}
          />
        </View>
      ) : null}

      {/* Button + shake wrapper */}
      <Animated.View style={shakeStyle}>
        <Pressable
          onPressIn={mode === "ptt" ? handlePressIn : undefined}
          onPressOut={mode === "ptt" ? handlePressOut : undefined}
          onPress={mode === "toggle" ? handlePress : undefined}
          onLongPress={handleLongPress}
          delayLongPress={400}
          disabled={tapDisabled}
          accessibilityLabel={a11yLabel}
          accessibilityHint={a11yHint}
          accessibilityRole="button"
          accessibilityState={{
            disabled: tapDisabled,
            selected: visualState === "recording",
          }}
          style={[
            {
              width: size,
              height: size,
              borderRadius: size / 2,
              borderWidth: 1.5,
              borderColor,
              backgroundColor: bgColor,
              alignItems: "center",
              justifyContent: "center",
              opacity: tapDisabled && modelStatus !== "downloading" ? 0.4 : 1,
            },
          ]}
        >
          {/* Reduced-motion REC dot overlaid on the icon when recording */}
          {reducedMotion && visualState === "recording" ? (
            <RecDot color={tokens.danger} />
          ) : null}

          {visualState === "recording" ? (
            <MicFilled size={iconSize} color={iconColor} />
          ) : (
            <MicOutline size={iconSize} color={iconColor} />
          )}
        </Pressable>
      </Animated.View>

      {/* Model state badges — rendered above the button */}
      {modelStatus === "absent" && visualState !== "recording" ? (
        <DownloadBadge color={tokens.ink} bg={tokens.surface} />
      ) : null}
      {modelStatus === "failed" ? (
        <ErrorBadge dangerColor={tokens.danger} />
      ) : null}
    </View>
  );
}
