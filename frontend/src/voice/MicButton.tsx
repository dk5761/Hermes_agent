/**
 * MicButton — mic button for the chat composer (MEMO-ONLY mode).
 *
 * VOICE_TRANSCRIBE_DISABLED: The transcribe-to-composer path (useVoiceInput,
 * tap-to-toggle transcription) has been commented out. Both tap and long-press
 * now record voice memos that upload via postVoiceMemo and appear as audio
 * bubbles in chat. To restore the transcribe path:
 *   1. Uncomment the `// VOICE_TRANSCRIBE_DISABLED:` blocks in this file.
 *   2. Restore the onVoiceTranscript / onVoiceTranscriptChange / onVoiceRecordingStart
 *      wiring in chat/[id].tsx (search VOICE_TRANSCRIBE_DISABLED there too).
 *   3. Remove the tap-toggle memo path added below.
 *
 * Current gesture model (memo-only):
 *   tap       → toggle memo recording (first tap starts; second tap stops + uploads)
 *   long-hold → PTT memo (record while held, send on release; slide-to-cancel)
 *   Both paths upload via postVoiceMemo and push an audio bubble into the chat.
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
 * Slide-to-cancel:
 *   We use plain Pressable onPressIn / onPressOut and track the touch position
 *   via onLayout (to get button bounds) plus a pan handler implemented with
 *   the ViewResponder system (onStartShouldSetResponder + onResponderMove) on
 *   an outer View. Memo-path uses MEMO_CANCEL_THRESHOLD_PT.
 *
 *   Why this approach rather than react-native-gesture-handler (RNGH)?
 *   RNGH is in package.json but is used as Expo Router's gesture provider, not
 *   imported directly by any UI component in this codebase. The plain Responder
 *   approach keeps MicButton self-contained, avoids wrapping the button in a
 *   GestureDetector, and is sufficient for the single gesture we need.
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
// VOICE_TRANSCRIBE_DISABLED: useVoiceInput drives the transcribe-to-composer
// path. Kept intact on disk; callers are commented out here and in chat/[id].tsx.
// import { useVoiceInput } from "./useVoiceInput";
// import type { VoiceInputError } from "./useVoiceInput";
import { VoiceMemoRecorder } from "./voice-memo-recorder";
import { postVoiceMemo } from "../api/voice-memo";
import { useChatStore } from "../state/chat-store";

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
  /*
   * VOICE_TRANSCRIBE_DISABLED: The following props fed the transcribe-to-composer
   * path. They are commented out from the interface. To restore:
   *   - Uncomment these props.
   *   - Uncomment the useVoiceInput call and its useEffects below.
   *   - Restore MicButton callers in chat/[id].tsx.
   *
   * onTranscript: (text: string) => void;
   * onTranscriptChange?: (fullTranscript: string) => void;
   * onRecordingStart?: () => void;
   * onPartial?: (text: string) => void;
   * onError?: (err: VoiceInputError) => void;
   * language?: string;
   * addsPunctuation?: boolean;
   */

  /** Disable the button (e.g., while agent is streaming). */
  disabled?: boolean;
  /** Optional size in points. Default 44 (iOS HIG min tap target). */
  size?: number;
  /** Active session ID. Required for memo upload. */
  sessionId?: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type VisualState = "idle" | "recording" | "error";

export function MicButton({
  disabled = false,
  size = DEFAULT_SIZE,
  sessionId,
}: MicButtonProps): React.ReactElement {
  const tokens = useThemeTokens();
  const reducedMotion = useReducedMotion();

  /*
   * VOICE_TRANSCRIBE_DISABLED: useVoiceInput + all transcript-forwarding effects
   * were here. Removed callers; hook kept intact on disk.
   *
   * To restore:
   *   1. Add back onTranscript, onTranscriptChange, onRecordingStart, onPartial,
   *      onError, language, addsPunctuation to the prop signature above.
   *   2. Uncomment the block below.
   *
   * const voice = useVoiceInput({
   *   language,
   *   addsPunctuation,
   *   onFinalTranscript: onTranscript,
   *   sessionId: sessionId ?? undefined,
   * });
   *
   * // Sync recording / error transitions from the hook's state machine.
   * useEffect(() => {
   *   const k = voice.state.kind;
   *   if (k === "recording") {
   *     setVisualState("recording");
   *     if (!recordingStartFiredRef.current) {
   *       recordingStartFiredRef.current = true;
   *       onRecordingStart?.();
   *     }
   *   } else if (k === "error") {
   *     recordingStartFiredRef.current = false;
   *     setVisualState("error");
   *     const t = setTimeout(() => setVisualState("idle"), ERROR_DISPLAY_MS);
   *     return () => clearTimeout(t);
   *   } else if (k === "idle" || k === "stopping") {
   *     if (k === "idle") {
   *       recordingStartFiredRef.current = false;
   *       setVisualState("idle");
   *     }
   *   }
   *   return undefined;
   * }, [voice.state, onRecordingStart]);
   *
   * // Surface error to caller.
   * useEffect(() => {
   *   if (voice.state.kind === "error") onError?.(voice.state.error);
   * }, [voice.state, onError]);
   *
   * // Forward partials.
   * useEffect(() => {
   *   if (voice.state.kind === "recording") onPartial?.(voice.state.partialTranscript);
   * }, [voice.state, onPartial]);
   *
   * // Emit incremental transcript changes.
   * const prevTranscriptRef = useRef<string>("");
   * useEffect(() => {
   *   if (voice.transcript !== prevTranscriptRef.current) {
   *     prevTranscriptRef.current = voice.transcript;
   *     if (voice.isListening && voice.transcript.length > 0) {
   *       onTranscriptChange?.(voice.transcript);
   *     }
   *   }
   * }, [voice.transcript, voice.isListening, onTranscriptChange]);
   */

  // -------------------------------------------------------------------------
  // Local visual state — driven by memo recording now (no voice.state)
  // -------------------------------------------------------------------------

  const [visualState, setVisualState] = useState<VisualState>("idle");

  // -------------------------------------------------------------------------
  // Slide-to-cancel tracking (memo path only)
  // -------------------------------------------------------------------------

  /**
   * Holds the Y coordinate of the button's top edge in screen coordinates.
   * Populated by the onLayout callback on the outer wrapper.
   */
  const buttonTopRef = useRef<number>(0);

  // VOICE_TRANSCRIBE_DISABLED: cancelOnReleaseRef was used to cancel the
  // transcribe-path when the finger slid upward past CANCEL_THRESHOLD_PT.
  // Kept as a dead ref so the constant CANCEL_THRESHOLD_PT compiles without
  // an "unused variable" error — or comment out both if TS complains.
  // const cancelOnReleaseRef = useRef<boolean>(false);

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
      const touchY = e.nativeEvent.pageY;
      const touchX = e.nativeEvent.pageX;

      // VOICE_TRANSCRIBE_DISABLED: transcribe-path upward-slide cancel removed.
      // Original code:
      //   if (touchY < buttonTopRef.current - CANCEL_THRESHOLD_PT) {
      //     cancelOnReleaseRef.current = true;
      //   }

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
    []
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

  /*
   * VOICE_TRANSCRIBE_DISABLED: model-state derived values (modelStatus,
   * modelProgress) were read from voice.modelStatus / voice.modelProgress and
   * used to:
   *   - Show a ProgressRing around the button during WhisperKit model download.
   *   - Show DownloadBadge (absent) / ErrorBadge (failed) on the button corner.
   *   - Disable taps while the model was downloading.
   *   - Display model-specific accessibility labels.
   *
   * To restore: uncomment these two lines and re-wire voice.* reads.
   *   const modelStatus = voice.modelStatus;
   *   const modelProgress = voice.modelProgress;
   */

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

  // Sync visualState with memo recording lifecycle.
  // isMemoRecording=true → "recording"; false (+ not uploading) → "idle".
  // This replaces the voice.state-driven effect that was commented out above.
  useEffect(() => {
    if (isMemoRecording) {
      setVisualState("recording");
    } else if (!isMemoUploading) {
      setVisualState("idle");
    }
  }, [isMemoRecording, isMemoUploading]);

  // Button is disabled only by the parent's disabled flag or while uploading.
  // VOICE_TRANSCRIBE_DISABLED: was `disabled || modelStatus === "downloading"`.
  const tapDisabled = disabled || isMemoUploading;

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
      const voiceMsg = await postVoiceMemo(sessionId, result.uri, result.durationMs);
      // Optimistic insert: push the user voice bubble into the live chat-store
      // immediately so it appears before the assistant streams its response.
      // The id format mirrors historyRowToUiRow ("hist-u-<dbId>"), so the
      // dedup filter in the rows useMemo will drop the server-side history
      // copy when the next paginated refetch arrives, preventing duplication.
      useChatStore.getState().pushVoiceMemoMessage(sessionId, voiceMsg);
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
  // Press handlers — MEMO-ONLY (tap-toggle + PTT)
  //
  // Tap-toggle semantics (pattern B from the spec):
  //   First tap (isMemoRecording=false, heldMs < threshold):
  //     → start recording, set isTapToggleRecordingRef = true.
  //   Second tap (isMemoRecording=true, heldMs < threshold):
  //     → commitMemoRecording (stop + upload).
  //
  // PTT (long-hold, heldMs >= LONG_PRESS_THRESHOLD_MS):
  //   pressIn starts recording immediately (via handlePressIn if not already
  //   recording). handleLongPress fires after delayLongPress ms — it's a no-op
  //   now since recording started in pressIn. pressOut commits the memo.
  //
  // isTapToggleRecordingRef arms the second-tap commit path.
  //
  // VOICE_TRANSCRIBE_DISABLED: original handlers used voice.start() /
  // voice.cancel() / voice.stop() here. Kept as commented block below.
  // -------------------------------------------------------------------------

  /**
   * True when the user tapped once (not PTT) and the recorder is running.
   * The second tap detects this flag and commits the recording.
   */
  const isTapToggleRecordingRef = useRef<boolean>(false);

  const handlePressIn = useCallback((e: GestureResponderEvent) => {
    if (tapDisabled) return;

    pressInTimeRef.current = Date.now();
    pressOriginRef.current = {
      x: e.nativeEvent.pageX,
      y: e.nativeEvent.pageY,
    };

    // Start recording immediately — works for both tap-toggle first-tap and PTT.
    // If already recording (tap-toggle second-tap path), do nothing here;
    // handlePressOut will detect isTapToggleRecordingRef and commit.
    if (!memoRecorder.isRecording) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
      void startMemoRecording();
    }
  }, [tapDisabled, memoRecorder, startMemoRecording]);

  const handlePressOut = useCallback(() => {
    if (tapDisabled) return;

    const heldMs = Date.now() - pressInTimeRef.current;

    if (heldMs >= LONG_PRESS_THRESHOLD_MS) {
      // PTT path: finger held long enough — release commits the recording.
      isTapToggleRecordingRef.current = false;
      void commitMemoRecording();
    } else {
      // Tap path (short press).
      if (isTapToggleRecordingRef.current) {
        // Second tap — recording is live; commit it.
        isTapToggleRecordingRef.current = false;
        void commitMemoRecording();
      } else {
        // First tap — recording just started in handlePressIn; arm toggle flag.
        // The recording bar is now visible; the next tap will commit.
        isTapToggleRecordingRef.current = true;
      }
    }
  }, [tapDisabled, commitMemoRecording]);

  // -------------------------------------------------------------------------
  // Long-press handler — PTT is already started in pressIn; this is a no-op
  // for the memo path. Kept so delayLongPress fires without side-effects.
  // -------------------------------------------------------------------------

  const handleLongPress = useCallback(() => {
    // PTT recording was already started in handlePressIn.
    // isTapToggleRecordingRef stays false — PTT commits on pressOut via the
    // heldMs >= LONG_PRESS_THRESHOLD_MS branch, not the tap-toggle branch.

    /*
     * VOICE_TRANSCRIBE_DISABLED: original long-press triggered model download
     * when modelStatus was "absent" or "failed". Code:
     *
     * if (modelStatus === "downloading") return;
     * if (modelStatus === "absent" || modelStatus === "failed") {
     *   void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
     *   void voice.ensureModelReady().catch(() => {});
     *   return;
     * }
     */
  }, []);

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

  /*
   * VOICE_TRANSCRIBE_DISABLED: accessibility label previously described model
   * download state (absent / downloading / failed). Simplified to memo-only.
   * To restore: reinstate modelStatus / modelProgress branches.
   */
  const a11yLabel =
    visualState === "recording"
      ? "Voice memo. Tap again to send, or slide to cancel."
      : "Voice memo. Tap to start recording, tap again to stop and send. Hold to record while held.";

  // VOICE_TRANSCRIBE_DISABLED: a11yHint previously reflected model download state.
  const a11yHint = "Slide left or down while holding to cancel.";

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const iconSize = Math.round(size * 0.5);
  const pulseSize = size * 1.6;
  // VOICE_TRANSCRIBE_DISABLED: ringSize (size + 8) was used by ProgressRing
  // during WhisperKit model download. Removed; kept as comment for restoration.
  // const ringSize = size + 8;

  // Memo recording bar visible state: show when actively recording or uploading.
  const showMemoBar = isMemoRecording || isMemoUploading;

  return (
    <View
      onLayout={handleLayout}
      onStartShouldSetResponder={() => true}
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

      {/*
        * VOICE_TRANSCRIBE_DISABLED: WhisperKit model download progress ring.
        * Shown while modelStatus === "downloading". Requires modelStatus +
        * modelProgress from voice.modelStatus / voice.modelProgress.
        * To restore: uncomment and wire voice.modelStatus / voice.modelProgress.
        *
        * {modelStatus === "downloading" ? (
        *   <View
        *     pointerEvents="none"
        *     style={{ position: "absolute", width: ringSize, height: ringSize }}
        *   >
        *     <ProgressRing size={ringSize} progress={modelProgress} color={tokens.accent} />
        *   </View>
        * ) : null}
        */}

      {/* Button + shake wrapper */}
      <Animated.View style={shakeStyle}>
        <Pressable
          onPressIn={handlePressIn}
          onPressOut={handlePressOut}
          onLongPress={handleLongPress}
          delayLongPress={LONG_PRESS_THRESHOLD_MS}
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
              opacity: tapDisabled ? 0.4 : 1,
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

      {/*
        * VOICE_TRANSCRIBE_DISABLED: WhisperKit model state badges (DownloadBadge
        * for absent, ErrorBadge for failed). Requires modelStatus.
        * To restore: uncomment and wire voice.modelStatus.
        *
        * {modelStatus === "absent" && visualState !== "recording" ? (
        *   <DownloadBadge color={tokens.ink} bg={tokens.surface} />
        * ) : null}
        * {modelStatus === "failed" ? (
        *   <ErrorBadge dangerColor={tokens.danger} />
        * ) : null}
        */}

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
