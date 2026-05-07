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
  AppState,
  Keyboard,
  Pressable,
  Text,
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
import { RecordingPresets, useAudioRecorder } from "expo-audio";
import Svg, { Circle, Path } from "react-native-svg";

import { useThemeTokens } from "@/components/ui/tokens";
import { showToast } from "@/components/ui/Toast";
import { useVoiceInput } from "./useVoiceInput";
import type { VoiceInputError } from "./useVoiceInput";
import { VoiceMemoRecorder } from "./voice-memo-recorder";
import { postVoiceMemo } from "../api/voice-memo";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum tap-target size per iOS HIG. */
const DEFAULT_SIZE = 44;

/**
 * How far (in points) the finger must travel upward above the button's top
 * edge before the press is treated as a cancel gesture (transcribe/PTT path).
 */
const CANCEL_THRESHOLD_PT = 20;

/**
 * How many ms between pressIn and pressOut before we treat the gesture as a
 * long-press (memo path) rather than a tap (transcribe path).
 */
const LONG_PRESS_THRESHOLD_MS = 250;

/**
 * Slide-to-cancel threshold for the memo path. If the finger moves more than
 * this many points downward OR leftward from the press origin, the recording
 * is cancelled (Telegram pattern — only the explicit slide cancels).
 */
const MEMO_CANCEL_THRESHOLD_PT = 80;

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
// RecordingBar — shown while a memo recording is in progress
// ---------------------------------------------------------------------------

/**
 * Telegram-style recording bar that overlays the composer area during a memo
 * hold. Shows elapsed time, a red pulse dot, and a slide-to-cancel hint.
 * When `willCancel` is true the hint switches to "Release to cancel".
 */
function RecordingBar({
  elapsedMs,
  willCancel,
  uploading,
}: {
  elapsedMs: number;
  willCancel: boolean;
  uploading: boolean;
}) {
  const tokens = useThemeTokens();

  const totalSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const timeStr = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

  return (
    <View
      style={{
        position: "absolute",
        bottom: 56, // sit above the composer row
        left: 0,
        right: 0,
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: 16,
        paddingVertical: 10,
        backgroundColor: tokens.surface,
        borderTopWidth: 1,
        borderTopColor: willCancel ? tokens.danger : tokens.line,
      }}
      pointerEvents="none"
    >
      {/* Red pulsing dot */}
      <View
        style={{
          width: 10,
          height: 10,
          borderRadius: 5,
          backgroundColor: tokens.danger,
          marginRight: 10,
        }}
      />

      {/* Timer */}
      <Text
        style={{
          color: tokens.ink,
          fontSize: 15,
          fontVariant: ["tabular-nums"],
          marginRight: 12,
        }}
      >
        {timeStr}
      </Text>

      {/* Hint text — changes when in cancel zone */}
      <Text
        style={{
          color: willCancel ? tokens.danger : tokens.ink3,
          fontSize: 13,
          flex: 1,
        }}
      >
        {uploading ? "Sending…" : willCancel ? "Release to cancel" : "← Slide to cancel"}
      </Text>
    </View>
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
  /** Active session ID forwarded to the server voice engine. */
  sessionId?: string | null;
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
  sessionId,
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
    sessionId: sessionId ?? undefined,
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

  // Ref-only flag so handleResponderMove can check memo mode without a state
  // dep (state would be declared later in the hook and cause a TS ordering error).
  const isMemoRecordingRef = useRef<boolean>(false);

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
      const touchX = e.nativeEvent.pageX;

      // Transcribe-path cancel (slide up above button).
      if (touchY < buttonTopRef.current - CANCEL_THRESHOLD_PT) {
        cancelOnReleaseRef.current = true;
      }

      // Memo-path cancel: slide down or left past MEMO_CANCEL_THRESHOLD_PT.
      if (isMemoRecordingRef.current) {
        const dy = touchY - pressOriginRef.current.y; // positive = down
        const dx = touchX - pressOriginRef.current.x; // negative = left
        const willCancel = dy > MEMO_CANCEL_THRESHOLD_PT || dx < -MEMO_CANCEL_THRESHOLD_PT;
        if (willCancel !== memoWillCancelRef.current) {
          memoWillCancelRef.current = willCancel;
          setMemoWillCancel(willCancel);
          if (willCancel) {
            // Crossing into cancel zone — warning haptic so the user knows the
            // next release will abort the recording.
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
          }
        }
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
  // Voice memo state — recorder instance + UI state
  // -------------------------------------------------------------------------

  // Native recorder instance — managed by expo-audio's hook lifecycle.
  const memoNativeRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

  // Stable class instance wrapping the native recorder.
  const memoRecorderRef = useRef<VoiceMemoRecorder | null>(null);
  if (memoRecorderRef.current === null) {
    memoRecorderRef.current = new VoiceMemoRecorder(memoNativeRecorder);
  }
  const memoRecorder = memoRecorderRef.current;

  // Whether a memo recording is in progress (shows the RecordingBar overlay).
  // Also kept in isMemoRecordingRef (declared earlier) for use in responder callbacks.
  const [isMemoRecording, setIsMemoRecordingState] = useState(false);
  const setIsMemoRecording = useCallback((v: boolean) => {
    isMemoRecordingRef.current = v;
    setIsMemoRecordingState(v);
  }, []);

  // Whether we're in the "uploading" phase after release.
  const [isMemoUploading, setIsMemoUploading] = useState(false);

  // Elapsed milliseconds shown in the RecordingBar timer.
  const [memoElapsedMs, setMemoElapsedMs] = useState(0);

  // True when the finger has drifted past MEMO_CANCEL_THRESHOLD_PT.
  const [memoWillCancel, setMemoWillCancel] = useState(false);

  // Refs for the long-press timing and finger tracking.
  const pressInTimeRef = useRef<number>(0);
  const pressOriginRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const memoWillCancelRef = useRef<boolean>(false);
  const memoTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // -------------------------------------------------------------------------
  // Animations — rec-bar slide-in / slide-out
  // -------------------------------------------------------------------------

  /**
   * Controls the horizontal slide animation of the RecordingBar. Starts off-
   * screen to the right (400 pt) and slides to 0 when recording begins, then
   * slides back out on send/cancel.
   */
  const recBarTranslateX = useSharedValue(400);

  useEffect(() => {
    if (isMemoRecording || isMemoUploading) {
      // Slide in from the right — 200ms ease-out.
      recBarTranslateX.value = withTiming(0, {
        duration: 200,
        easing: Easing.out(Easing.ease),
      });
    } else {
      // Slide back out to the right — 150ms ease-in.
      recBarTranslateX.value = withTiming(400, {
        duration: 150,
        easing: Easing.in(Easing.ease),
      });
    }
  }, [isMemoRecording, isMemoUploading, recBarTranslateX]);

  const recBarAnimStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: recBarTranslateX.value }],
  }));

  // -------------------------------------------------------------------------
  // AppState handler — cancel memo recording when backgrounded
  // -------------------------------------------------------------------------

  useEffect(() => {
    const sub = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active" && memoRecorder.isRecording) {
        void memoRecorder.cancel().catch(() => undefined);
        if (memoTimerRef.current !== null) {
          clearInterval(memoTimerRef.current);
          memoTimerRef.current = null;
        }
        setIsMemoRecording(false);
        setIsMemoUploading(false);
        setMemoElapsedMs(0);
        setMemoWillCancel(false);
        memoWillCancelRef.current = false;
      }
    });
    return () => sub.remove();
  }, [memoRecorder]);

  // -------------------------------------------------------------------------
  // Helpers — start/commit/cancel the memo
  // -------------------------------------------------------------------------

  // Stable ref so startMemoRecording can call commitMemoRecording at cap time
  // without creating a circular useCallback dependency.
  const commitMemoRecordingRef = useRef<() => Promise<void>>(() => Promise.resolve());

  const commitMemoRecording = useCallback(async (): Promise<void> => {
    if (memoTimerRef.current !== null) {
      clearInterval(memoTimerRef.current);
      memoTimerRef.current = null;
    }

    if (memoWillCancelRef.current) {
      // User slid past the cancel threshold — discard.
      await memoRecorder.cancel().catch(() => undefined);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft).catch(() => undefined);
      setIsMemoRecording(false);
      setIsMemoUploading(false);
      setMemoElapsedMs(0);
      setMemoWillCancel(false);
      memoWillCancelRef.current = false;
      return;
    }

    // Normal release — stop and upload. Light impact signals "sent".
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    setIsMemoUploading(true);

    const result = await memoRecorder.stop().catch(() => null);
    if (!result) {
      setIsMemoRecording(false);
      setIsMemoUploading(false);
      setMemoElapsedMs(0);
      return;
    }

    if (!sessionId) {
      // Guard: no session — bail gracefully without surfacing an alarming error.
      setIsMemoRecording(false);
      setIsMemoUploading(false);
      setMemoElapsedMs(0);
      showToast("No active session — memo discarded", "warning");
      return;
    }

    try {
      await postVoiceMemo(sessionId, result.uri, result.durationMs);
      // Success — the chat refetch triggered by the WS stream picks up the
      // new user + assistant turns. Nothing else to do here.
    } catch {
      showToast("Failed to send voice memo — please try again", "error");
    } finally {
      setIsMemoRecording(false);
      setIsMemoUploading(false);
      setMemoElapsedMs(0);
      setMemoWillCancel(false);
      memoWillCancelRef.current = false;
    }
  }, [memoRecorder, sessionId, setIsMemoRecording]);

  // Keep the ref current so cap-timer closures always call the latest version.
  commitMemoRecordingRef.current = commitMemoRecording;

  const startMemoRecording = useCallback(async (): Promise<void> => {
    if (memoRecorder.isRecording) return;
    memoWillCancelRef.current = false;
    setMemoWillCancel(false);
    setMemoElapsedMs(0);

    // Dismiss the keyboard so the rec-bar isn't fighting it for bottom space.
    Keyboard.dismiss();

    try {
      await memoRecorder.start();
    } catch {
      showToast("Could not start recording", "error");
      return;
    }

    setIsMemoRecording(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);

    // Tick every 500ms to update the duration counter. Stop at 10-min cap.
    const startTime = Date.now();
    const MAX_MEMO_MS = 10 * 60 * 1000;
    memoTimerRef.current = setInterval(() => {
      const elapsed = Date.now() - startTime;
      setMemoElapsedMs(elapsed);
      if (elapsed >= MAX_MEMO_MS && memoTimerRef.current !== null) {
        clearInterval(memoTimerRef.current);
        memoTimerRef.current = null;
        // Cap reached — commit what we have via stable ref (avoids circular dep).
        void commitMemoRecordingRef.current();
      }
    }, 500);
  }, [memoRecorder, setIsMemoRecording]);

  // -------------------------------------------------------------------------
  // PTT press handlers — tap-vs-long-press routing
  // -------------------------------------------------------------------------

  const handlePressIn = useCallback((e: GestureResponderEvent) => {
    if (tapDisabled) return;
    if (mode !== "ptt") return;
    if (modelStatus !== "ready" && modelStatus !== "absent") return;

    pressInTimeRef.current = Date.now();
    pressOriginRef.current = {
      x: e.nativeEvent.pageX,
      y: e.nativeEvent.pageY,
    };
    cancelOnReleaseRef.current = false;

    // Start voice transcription immediately (for the tap path). If the user
    // holds past LONG_PRESS_THRESHOLD_MS we cancel the transcription and enter
    // memo mode instead — handled inside handlePressOut.
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    void voice.start().catch(() => undefined);
  }, [tapDisabled, mode, modelStatus, voice]);

  const handlePressOut = useCallback(() => {
    if (tapDisabled) return;
    if (mode !== "ptt") return;

    const heldMs = Date.now() - pressInTimeRef.current;

    if (heldMs >= LONG_PRESS_THRESHOLD_MS) {
      // Long-press path: cancel the transcription session (which was started
      // on pressIn but should not emit a transcript) and commit the memo.
      voice.cancel();
      void commitMemoRecording();
    } else {
      // Tap path: hand off to the existing transcription stop/cancel logic.
      if (cancelOnReleaseRef.current) {
        cancelOnReleaseRef.current = false;
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft).catch(() => undefined);
        voice.cancel();
      } else {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
        void voice.stop();
      }
      // Ensure memo UI is clean (shouldn't be visible, but guard).
      setIsMemoRecording(false);
      setIsMemoUploading(false);
      setMemoElapsedMs(0);
    }
  }, [tapDisabled, mode, voice, commitMemoRecording]);

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
  // Long-press handler — memo recording start OR model download
  // -------------------------------------------------------------------------

  const handleLongPress = useCallback(() => {
    // Model download path (existing behaviour).
    if (modelStatus === "downloading") return;
    if (modelStatus === "absent" || modelStatus === "failed") {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
      void voice.ensureModelReady().catch(() => {
        // error forwarded via onError through the effect above
      });
      return;
    }

    // Model ready — enter memo mode. Voice transcription (started on pressIn)
    // is still running; commitMemoRecording will cancel it on pressOut.
    if (mode === "ptt" && !tapDisabled) {
      void startMemoRecording();
    }
  }, [modelStatus, mode, tapDisabled, voice, startMemoRecording]);

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

  // Memo recording bar visible state: show when actively recording or uploading.
  const showMemoBar = isMemoRecording || isMemoUploading;

  return (
    <View
      onLayout={handleLayout}
      onStartShouldSetResponder={() => mode === "ptt"}
      onResponderMove={handleResponderMove}
      style={{ width: size, height: size, alignItems: "center", justifyContent: "center", overflow: "visible" }}
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

      {/* Memo recording bar — floats above the composer row. Rendered outside
          the button's layout box via a wide absolute-positioned view. Always
          mounted while showMemoBar is true; the Animated.View handles the
          slide-in/out so layout is stable during the exit animation. */}
      {showMemoBar ? (
        <Animated.View
          style={[
            {
              position: "absolute",
              // Sit ~56pt above the bottom of this button (above the toolbar row).
              bottom: size + 8,
              // Stretch across the typical phone width from the button's centre.
              left: -200,
              right: -200,
            },
            recBarAnimStyle,
          ]}
          pointerEvents="none"
        >
          <RecordingBar
            elapsedMs={memoElapsedMs}
            willCancel={memoWillCancel}
            uploading={isMemoUploading}
          />
        </Animated.View>
      ) : null}
    </View>
  );
}
