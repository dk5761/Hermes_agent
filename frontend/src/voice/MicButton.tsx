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
 * ## Recording state machine
 *
 * ```
 * idle
 *   │
 *   ├── pressIn → recorder starts immediately
 *   │     │
 *   │     ├── pressOut (heldMs < 500, no drag) ──────► tap-toggle (rec keeps running)
 *   │     │         Second pressIn+pressOut in tap-toggle → commit
 *   │     │
 *   │     ├── (500ms timer fires, finger still down) ─► hold-active
 *   │     │         │
 *   │     │         ├── pressOut (no drag past cancel) ─► commit (classic PTT)
 *   │     │         ├── drag up > 60pt ─────────────────► locked-hold
 *   │     │         │         │
 *   │     │         │         ├── tap mic (stop icon) ──► commit
 *   │     │         │         └── drag down/left > 80pt ► cancelling → cancel
 *   │     │         └── drag down/left > 80pt ──────────► cancelling → cancel on release
 *   │     │
 *   │     └── drag down/left > 80pt (before 500ms) ──► cancelling → cancel on release
 * ```
 *
 * Visual states:
 *   idle         → outlined mic icon, neutral (ink3) tint, surface background
 *   tap-toggle   → filled mic icon, danger tint, pulse ring
 *   hold-active  → filled mic icon, danger tint, pulse ring + LockHint above
 *   locked-hold  → stop/square icon (mic transforms), danger tint, pulse ring
 *   cancelling   → filled mic icon, danger tint (strip shows red warning)
 *   error        → shake animation (~300ms, ±4pt), auto-reverts to idle after 2s
 *   disabled     → 40% opacity, non-interactive
 *
 * Slide-to-cancel uses ViewResponder (onStartShouldSetResponder + onResponderMove)
 * on an outer View. We deliberately avoid react-native-gesture-handler here to
 * keep MicButton self-contained; see the RNGH note in the original header.
 *
 * The RecordingStrip + RecordingOverlay are lifted to the parent chat screen
 * (chat/[id].tsx) and driven via the onRecordingStateChange callback.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  type LayoutChangeEvent,
  type GestureResponderEvent,
  AppState,
  Keyboard,
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
import { RecordingPresets, useAudioRecorder } from "expo-audio";
import Svg, { Path, Rect } from "react-native-svg";

import { useThemeTokens } from "@/components/ui/tokens";
import { showToast } from "@/components/ui/Toast";
import { Directory, File, Paths } from "expo-file-system";
import { VoiceMemoRecorder } from "./voice-memo-recorder";
import { useChatStore } from "../state/chat-store";
import { usePendingMemos } from "../state/pending-memos";
import { uploadPendingMemo } from "./voice-memo-uploader";
import { LockHint } from "./LockHint";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum tap-target size per iOS HIG. */
const DEFAULT_SIZE = 44;

/**
 * How many ms between pressIn and pressOut before we treat the gesture as a
 * hold (PTT path) rather than a tap (tap-toggle path).
 */
const LONG_PRESS_THRESHOLD_MS = 500;

/**
 * Slide-to-cancel threshold. If the finger moves more than this many points
 * downward OR leftward from the press origin, the recording is cancelled.
 */
const MEMO_CANCEL_THRESHOLD_PT = 80;

/**
 * Drag-up threshold to engage lock mode. If the finger moves more than this
 * many points UPWARD from the press origin while in hold-active state, the
 * recording locks (user can release the screen, recording continues).
 */
const LOCK_THRESHOLD_PT = 60;

/** Duration of the error-shake animation in ms (3 oscillations × 100ms each). */
const SHAKE_DURATION_MS = 100;

/** How long the error visual state is shown before auto-reverting to idle. */
const ERROR_DISPLAY_MS = 2000;

// ---------------------------------------------------------------------------
// State machine types
// ---------------------------------------------------------------------------

/**
 * Tagged-union recording state machine.
 *
 * - idle: no recording in progress.
 * - tap-toggle: user tapped once (release < 500ms, no drag). Recorder is
 *   running. Second tap-then-release will commit.
 * - hold-active: user has held the button for > 500ms. Still finger-down.
 *   Release without drag → commit.
 * - locked-hold: user dragged up > 60pt while in hold-active. Finger can be
 *   released; recording continues. Tap on the stop icon → commit.
 * - cancelling: drag past cancel threshold. Release will cancel.
 */
type RecordingState =
  | { kind: "idle" }
  | { kind: "tap-toggle"; startedAt: number }
  | { kind: "hold-active"; startedAt: number }
  | { kind: "locked-hold"; startedAt: number }
  | { kind: "cancelling"; startedAt: number };

// ---------------------------------------------------------------------------
// SVG icon paths + components
// ---------------------------------------------------------------------------

/** Outlined mic — used in idle state. */
const MIC_OUTLINE_PATH =
  "M12 2a3 3 0 00-3 3v6a3 3 0 006 0V5a3 3 0 00-3-3zM5 11a7 7 0 0014 0M12 18v3";

function MicOutline({ size, color, stroke = 1.6 }: { size: number; color: string; stroke?: number }) {
  const segments = MIC_OUTLINE_PATH.split("M").filter(Boolean);
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
      {segments.map((seg, i) => (
        <Path key={i} d={"M" + seg} />
      ))}
    </Svg>
  );
}

function MicFilled({ size, color }: { size: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12 2a3 3 0 00-3 3v6a3 3 0 006 0V5a3 3 0 00-3-3z" fill={color} stroke={color} strokeWidth={1.6} />
      <Path d="M5 11a7 7 0 0014 0M12 18v3" stroke={color} strokeWidth={1.6} />
    </Svg>
  );
}

/** Stop/square icon — shown in locked-hold state. Tap to commit. */
function StopIcon({ size, color }: { size: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x="5" y="5" width="14" height="14" rx="3" fill={color} />
    </Svg>
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

  /**
   * Called when recording starts (any mode). Parent uses this to show the
   * RecordingStrip and RecordingOverlay.
   */
  onRecordingStart?: () => void;

  /**
   * Called whenever the recording state transitions. Parent drives the
   * RecordingStrip's visual state from this.
   */
  onRecordingStateChange?: (state: Exclude<RecordingState, { kind: "idle" }> | null) => void;

  /**
   * Called when recording ends (commit or cancel). `committed` is true if the
   * memo was sent; false if cancelled. Parent hides the strip/overlay.
   */
  onRecordingEnd?: (committed: boolean) => void;

  /**
   * Called on each live waveform snapshot (~10 fps). Parent passes this to
   * RecordingOverlay as `livePeaks`.
   */
  onPeaksUpdate?: (peaks: number[]) => void;

  /**
   * Called once with a commit function. Parent stores the function and calls
   * it when the RecordingStrip's send button is tapped (tap-toggle / locked-hold).
   */
  onExposeCommit?: (commit: () => void) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type VisualState = "idle" | "recording" | "locked" | "error";

export function MicButton({
  disabled = false,
  size = DEFAULT_SIZE,
  sessionId,
  onRecordingStart,
  onRecordingStateChange,
  onRecordingEnd,
  onPeaksUpdate,
  onExposeCommit,
}: MicButtonProps): React.ReactElement {
  const tokens = useThemeTokens();
  const reducedMotion = useReducedMotion();

  // -------------------------------------------------------------------------
  // Local visual state
  // -------------------------------------------------------------------------

  const [visualState, setVisualState] = useState<VisualState>("idle");

  // -------------------------------------------------------------------------
  // Native recorder
  // -------------------------------------------------------------------------

  const memoNativeRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const memoRecorderRef = useRef<VoiceMemoRecorder | null>(null);
  if (memoRecorderRef.current === null) {
    memoRecorderRef.current = new VoiceMemoRecorder(memoNativeRecorder);
  }
  const memoRecorder = memoRecorderRef.current;

  // -------------------------------------------------------------------------
  // Recording state machine
  // -------------------------------------------------------------------------

  const [recState, setRecState] = useState<RecordingState>({ kind: "idle" });
  const recStateRef = useRef<RecordingState>({ kind: "idle" });

  const setRecordingState = useCallback((next: RecordingState) => {
    recStateRef.current = next;
    setRecState(next);
    if (next.kind === "idle") {
      onRecordingStateChange?.(null);
    } else {
      onRecordingStateChange?.(next);
    }
  }, [onRecordingStateChange]);

  // Whether a recording is currently in progress (any non-idle state).
  const isRecordingRef = useRef(false);

  // -------------------------------------------------------------------------
  // Elapsed timer
  // -------------------------------------------------------------------------

  const [elapsedMs, setElapsedMs] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);

  const startTimer = useCallback(() => {
    if (timerRef.current !== null) clearInterval(timerRef.current);
    startTimeRef.current = Date.now();
    setElapsedMs(0);
    const MAX_MEMO_MS = 10 * 60 * 1000;
    timerRef.current = setInterval(() => {
      const elapsed = Date.now() - startTimeRef.current;
      setElapsedMs(elapsed);
      if (elapsed >= MAX_MEMO_MS && timerRef.current !== null) {
        clearInterval(timerRef.current);
        timerRef.current = null;
        void commitMemoRecordingRef.current();
      }
    }, 100);
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // -------------------------------------------------------------------------
  // Gesture tracking refs
  // -------------------------------------------------------------------------

  const pressOriginRef = useRef<{ x: number; y: number; time: number }>({ x: 0, y: 0, time: 0 });
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelThresholdActiveRef = useRef(false);

  const buttonTopRef = useRef<number>(0);
  const handleLayout = useCallback((e: LayoutChangeEvent) => {
    buttonTopRef.current = e.nativeEvent.layout.y;
  }, []);

  // -------------------------------------------------------------------------
  // Animations — pulse ring
  // -------------------------------------------------------------------------

  const pulseScale = useSharedValue(1);
  const pulseOpacity = useSharedValue(0);

  useEffect(() => {
    const isRecording = visualState === "recording" || visualState === "locked";
    if (isRecording && !reducedMotion) {
      pulseScale.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 0 }),
          withTiming(1.8, { duration: 1200, easing: Easing.out(Easing.ease) }),
        ),
        -1, false,
      );
      pulseOpacity.value = withRepeat(
        withSequence(
          withTiming(0.5, { duration: 0 }),
          withTiming(0, { duration: 1200, easing: Easing.out(Easing.ease) }),
        ),
        -1, false,
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
        withTiming(0, { duration: SHAKE_DURATION_MS }),
      );
    }
  }, [visualState, shakeX]);

  const shakeStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: shakeX.value }],
  }));

  // -------------------------------------------------------------------------
  // Colors derived from visual state
  // -------------------------------------------------------------------------

  const isActiveRecording =
    visualState === "recording" || visualState === "locked";

  const iconColor = isActiveRecording ? tokens.danger : tokens.ink3;
  if (visualState === "error") {
    // error also uses danger — handled inline below
  }

  const borderColor = isActiveRecording || visualState === "error"
    ? tokens.danger
    : tokens.line;

  const bgColor = isActiveRecording ? tokens.accentBg : tokens.surface;

  const tapDisabled = disabled;

  // -------------------------------------------------------------------------
  // Core commit/cancel helpers
  // -------------------------------------------------------------------------

  const commitMemoRecordingRef = useRef<() => Promise<void>>(() => Promise.resolve());

  const commitMemoRecording = useCallback(async (): Promise<void> => {
    stopTimer();
    isRecordingRef.current = false;
    // Clean up peaks subscription before stopping recorder.
    if (peaksUnsubRef.current) {
      peaksUnsubRef.current();
      peaksUnsubRef.current = null;
    }
    setRecordingState({ kind: "idle" });
    setVisualState("idle");

    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);

    const result = await memoRecorder.stop().catch(() => null);
    if (!result) {
      onRecordingEnd?.(false);
      return;
    }

    if (!sessionId) {
      onRecordingEnd?.(false);
      showToast("No active session — memo discarded", "warning");
      return;
    }

    // Copy temp recording to a permanent path so it survives app restarts.
    const pendingDir = new Directory(Paths.document, "voice-memo-pending");
    if (!pendingDir.exists) pendingDir.create({ idempotent: true, intermediates: true });

    const permanentFile = new File(pendingDir, `memo-${Date.now()}.m4a`);
    let localAudioUri = result.uri;
    try {
      const tempFile = new File(result.uri);
      tempFile.copy(permanentFile);
      localAudioUri = permanentFile.uri;
    } catch {
      console.warn("[mic-button] could not copy audio to permanent path");
    }

    const localId = usePendingMemos.getState().enqueue({
      sessionId,
      localAudioUri,
      durationMs: result.durationMs,
      peaks: result.peaks,
    });

    useChatStore.getState().pushVoiceMemoMessage(sessionId, {
      id: localId,
      sessionId,
      audioPeaks: result.peaks,
      audioDurationMs: result.durationMs,
      transcriptionStatus: "transcribing",
      audioBlobUrl: undefined,
      localAudioUri,
    });

    onRecordingEnd?.(true);
    void uploadPendingMemo(localId);
  }, [memoRecorder, sessionId, stopTimer, setRecordingState, onRecordingEnd]);

  commitMemoRecordingRef.current = commitMemoRecording;

  // Expose commit function to parent (for RecordingStrip send button).
  useEffect(() => {
    if (onExposeCommit) {
      onExposeCommit(() => void commitMemoRecording());
    }
  // onExposeCommit is stable (useCallback in parent); commitMemoRecording
  // changes when sessionId changes. The ref ensures the exposed fn always
  // calls the latest version.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onExposeCommit]);

  // Stable ref so the exposed commit always calls the latest commitMemoRecording.
  // (commitMemoRecordingRef.current already serves this purpose.)

  const cancelMemoRecording = useCallback(async (): Promise<void> => {
    stopTimer();
    isRecordingRef.current = false;
    // Clean up peaks subscription before stopping recorder.
    if (peaksUnsubRef.current) {
      peaksUnsubRef.current();
      peaksUnsubRef.current = null;
    }
    setRecordingState({ kind: "idle" });
    setVisualState("idle");

    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft).catch(() => undefined);
    await memoRecorder.cancel().catch(() => undefined);
    onRecordingEnd?.(false);
  }, [memoRecorder, stopTimer, setRecordingState, onRecordingEnd]);

  // -------------------------------------------------------------------------
  // Start recording
  // -------------------------------------------------------------------------

  // Ref to the live peaks subscription unsub function. Cleaned up on cancel/commit.
  const peaksUnsubRef = useRef<(() => void) | null>(null);

  const startMemoRecording = useCallback(async (originTime: number): Promise<void> => {
    if (memoRecorder.isRecording) return;
    Keyboard.dismiss();

    try {
      await memoRecorder.start();
    } catch {
      showToast("Could not start recording", "error");
      return;
    }

    isRecordingRef.current = true;
    startTimer();
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    onRecordingStart?.();
    setVisualState("recording");

    // Subscribe to live peaks so parent can render the waveform overlay.
    if (onPeaksUpdate) {
      if (peaksUnsubRef.current) peaksUnsubRef.current();
      peaksUnsubRef.current = memoRecorder.subscribeToPeaks(onPeaksUpdate);
    }

    // After LONG_PRESS_THRESHOLD_MS of holding, transition to hold-active.
    const delay = LONG_PRESS_THRESHOLD_MS - (Date.now() - originTime);
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null;
      const current = recStateRef.current;
      // Only transition if we're still in an "active press" state (not tap-toggle
      // which means the finger is already up).
      if (current.kind === "idle" && isRecordingRef.current) {
        // The finger must still be down (otherwise we would have moved to tap-toggle).
        // We use a separate isFingerDownRef to track this.
        if (isFingerDownRef.current) {
          setRecordingState({ kind: "hold-active", startedAt: originTime });
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
        }
      }
    }, Math.max(0, delay));
  }, [memoRecorder, startTimer, onRecordingStart, setRecordingState, onPeaksUpdate]);

  // Tracks whether the finger is currently pressed down on the button.
  const isFingerDownRef = useRef(false);

  // -------------------------------------------------------------------------
  // Gesture responder: move handler for drag detection
  // -------------------------------------------------------------------------

  const handleResponderMove = useCallback((e: GestureResponderEvent) => {
    const touchY = e.nativeEvent.pageY;
    const touchX = e.nativeEvent.pageX;
    const dy = touchY - pressOriginRef.current.y; // positive = finger moved down
    const dx = touchX - pressOriginRef.current.x; // negative = finger moved left

    const current = recStateRef.current;
    if (current.kind === "idle") return;

    // Cancel threshold: finger slid DOWN or LEFT past threshold.
    const willCancel = dy > MEMO_CANCEL_THRESHOLD_PT || dx < -MEMO_CANCEL_THRESHOLD_PT;

    // Lock threshold: finger dragged UP > LOCK_THRESHOLD_PT during hold-active.
    const willLock = dy < -LOCK_THRESHOLD_PT && current.kind === "hold-active";

    if (willLock) {
      // Transition to locked-hold. Haptic: notification success.
      setRecordingState({ kind: "locked-hold", startedAt: current.startedAt });
      setVisualState("locked");
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      cancelThresholdActiveRef.current = false;
      return;
    }

    if (willCancel && !cancelThresholdActiveRef.current) {
      cancelThresholdActiveRef.current = true;
      setRecordingState({ kind: "cancelling", startedAt: current.startedAt });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
    } else if (!willCancel && cancelThresholdActiveRef.current) {
      // Dragged back inside the safe zone — revert to the appropriate mode.
      cancelThresholdActiveRef.current = false;
      const heldMs = Date.now() - current.startedAt;
      if (heldMs >= LONG_PRESS_THRESHOLD_MS || isFingerDownRef.current) {
        // Still holding long enough → hold-active.
        setRecordingState({ kind: "hold-active", startedAt: current.startedAt });
      } else {
        // Short hold — stay as tap-toggle.
        setRecordingState({ kind: "tap-toggle", startedAt: current.startedAt });
      }
    }
  }, [setRecordingState]);

  // -------------------------------------------------------------------------
  // Press handlers
  // -------------------------------------------------------------------------

  const handlePressIn = useCallback((e: GestureResponderEvent) => {
    if (tapDisabled) return;

    const now = Date.now();
    pressOriginRef.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY, time: now };
    isFingerDownRef.current = true;
    cancelThresholdActiveRef.current = false;

    const current = recStateRef.current;

    if (current.kind === "idle") {
      // First press: always start the recorder immediately.
      void startMemoRecording(now);
    }
    // If current.kind === "tap-toggle", this is the second press (second tap).
    // We don't start anything — handlePressOut will commit.
    // locked-hold: tap on the stop icon → handlePressOut will commit.
  }, [tapDisabled, startMemoRecording]);

  const handlePressOut = useCallback(() => {
    if (tapDisabled) return;

    isFingerDownRef.current = false;

    // Cancel any pending hold timer (if finger lifts before 500ms fires).
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }

    const current = recStateRef.current;
    const heldMs = Date.now() - pressOriginRef.current.time;

    switch (current.kind) {
      case "idle":
        // The recorder started in pressIn (state was idle then). The 500ms
        // hold timer hasn't fired yet — this is the FIRST tap (short press).
        // Transition to tap-toggle: rec keeps running, next pressOut commits.
        if (isRecordingRef.current) {
          setRecordingState({ kind: "tap-toggle", startedAt: pressOriginRef.current.time });
        }
        return;

      case "tap-toggle":
        // This is the SECOND tap (second pressOut in tap-toggle mode) → commit.
        void commitMemoRecording();
        return;

      case "hold-active":
        // Finger lifted while holding (no cancel, no lock) → commit (classic PTT).
        void commitMemoRecording();
        return;

      case "locked-hold":
        // In locked-hold, the mic icon transforms to a stop button. A tap/pressOut
        // on the mic button in this state commits the recording.
        void commitMemoRecording();
        return;

      case "cancelling":
        // Finger lifted while in cancel zone → abort.
        void cancelMemoRecording();
        return;
    }

    // Exhaustive: heldMs is used for logging only (tap-toggle already handled).
    void heldMs;
  }, [tapDisabled, commitMemoRecording, cancelMemoRecording, setRecordingState]);

  // -------------------------------------------------------------------------
  // AppState handler — cancel recording when backgrounded
  // -------------------------------------------------------------------------

  useEffect(() => {
    const sub = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active" && memoRecorder.isRecording) {
        void cancelMemoRecording();
      }
    });
    return () => {
      sub.remove();
      // Clean up any active peaks subscription on unmount.
      if (peaksUnsubRef.current) {
        peaksUnsubRef.current();
        peaksUnsubRef.current = null;
      }
    };
  }, [memoRecorder, cancelMemoRecording]);

  // -------------------------------------------------------------------------
  // Error haptic
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (visualState === "error") {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
    }
  }, [visualState]);

  // -------------------------------------------------------------------------
  // Accessibility
  // -------------------------------------------------------------------------

  const a11yLabel =
    recState.kind === "locked-hold"
      ? "Voice memo. Tap to send."
      : recState.kind !== "idle"
        ? "Voice memo. Tap again to send, or slide to cancel."
        : "Voice memo. Tap to start recording, tap again to stop and send. Hold to record while held.";

  const a11yHint = "Slide left or down while holding to cancel.";

  // -------------------------------------------------------------------------
  // Derived display flags
  // -------------------------------------------------------------------------

  const showLockHint = recState.kind === "hold-active";
  const iconSize = Math.round(size * 0.5);
  const pulseSize = size * 1.6;

  return (
    <View
      onLayout={handleLayout}
      onStartShouldSetResponder={() => isRecordingRef.current}
      onResponderMove={handleResponderMove}
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
        overflow: "visible",
      }}
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

      {/* LockHint — floats above the button during hold-active */}
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          bottom: size + 12,
          alignItems: "center",
          width: 80,
        }}
      >
        <LockHint visible={showLockHint} />
      </View>

      {/* Button + shake wrapper */}
      <Animated.View style={shakeStyle}>
        <Pressable
          onPressIn={handlePressIn}
          onPressOut={handlePressOut}
          disabled={tapDisabled}
          accessibilityLabel={a11yLabel}
          accessibilityHint={a11yHint}
          accessibilityRole="button"
          accessibilityState={{
            disabled: tapDisabled,
            selected: recState.kind !== "idle",
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
          {recState.kind === "locked-hold" ? (
            <StopIcon size={iconSize} color={iconColor} />
          ) : recState.kind !== "idle" ? (
            <MicFilled size={iconSize} color={iconColor} />
          ) : (
            <MicOutline size={iconSize} color={iconColor} />
          )}
        </Pressable>
      </Animated.View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Re-export elapsed time for parent to subscribe
// ---------------------------------------------------------------------------

export type { RecordingState };
