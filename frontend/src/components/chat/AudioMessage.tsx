/**
 * AudioMessage — Telegram-style audio bubble rendered in the chat list.
 *
 * Layout:
 *   ┌──────────────────────────────────────────────┐
 *   │  ▶  ▓▓▓▓▓░░░░░░░░░░░░░░  0:14 / 0:32        │
 *   ├──────────────────────────────────────────────┤
 *   │  Transcription                          ▼    │  ← collapsed (default)
 *   └──────────────────────────────────────────────┘
 *
 * Tap the "Transcription" row to expand and read the text. Tap again to
 * collapse. While transcription is in flight the spinner row replaces the
 * accordion (status-based rendering). Failed transcriptions show a retry CTA
 * inline, always visible (user must act).
 *
 * Single-playback contract: all instances share the `playbackController`
 * Zustand store. Only one message plays at a time — tapping a second bubble
 * stops the first automatically (handled inside the controller).
 */

import React, { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";

import { retryTranscription } from "@/api/voice-memo";
import type { TranscriptionStatus } from "@/api/voice-memo";
import {
  playbackController,
  usePlaybackState,
} from "@/audio/playback-controller";
import { Icon } from "@/components/ui/Icon";
import { Row } from "@/components/ui/Row";
import { Text } from "@/components/ui/Text";
import { useThemeTokens } from "@/components/ui/tokens";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface AudioMessageProps {
  messageId: string;
  sessionId: string;
  /**
   * Controls visual layout and feature visibility.
   * - `"user"` (default): right-aligned ink bubble with transcription accordion
   *   and retry CTA.
   * - `"assistant"`: left-aligned surface bubble; transcription accordion and
   *   retry CTA are hidden because the agent's text bubble already carries the
   *   transcript.
   */
  variant?: "user" | "assistant";
  /**
   * Relative path like `/voice-blobs/voice/<sha>.m4a`. Set ONCE the upload
   * has succeeded and the server has stored the blob. Optimistic memos
   * before upload completes have this undefined; playback falls back to
   * `localAudioUri` until the swap.
   */
  audioBlobUrl?: string;
  /**
   * `file://` URI on the device for the still-pending memo. Used for
   * playback while the upload is in flight or has failed. Server-acknowledged
   * memos may have this undefined (cache fetched on demand).
   */
  localAudioUri?: string;
  /** Total duration in milliseconds. */
  audioDurationMs: number;
  transcript: string;
  transcriptionStatus: TranscriptionStatus;
  transcriptionError?: string | null;
  /** Waveform peaks (80 floats 0..1). Null/empty → plain scrubber. */
  audioPeaks?: number[] | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a millisecond value as `M:SS`. */
function fmtMs(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const BAR_WIDTH = 140; // logical pixels — the progress bar's fixed width
const THUMB_SIZE = 10; // diameter of the draggable thumb dot

// Waveform geometry constants. Bar/gap tightened from 2/1 to 1/1 so the
// 80 bars fit inside an iPhone-SE-friendly bubble (320pt fixed width). The
// peaks data still has 80 values — only the visual rendering is tighter.
const WAVEFORM_BAR_WIDTH = 1; // pt per bar
const WAVEFORM_GAP = 1; // pt between bars
const WAVEFORM_BAR_COUNT = 80;
const WAVEFORM_MAX_HEIGHT = 24; // pt
const WAVEFORM_MIN_HEIGHT = 2; // pt
// 80 bars × 1pt + 79 gaps × 1pt = 159pt
const WAVEFORM_TOTAL_WIDTH = WAVEFORM_BAR_COUNT * WAVEFORM_BAR_WIDTH + (WAVEFORM_BAR_COUNT - 1) * WAVEFORM_GAP;

/**
 * Audio scrubber — supports both tap-to-seek and drag-to-seek.
 *
 * During a drag the thumb follows the finger immediately (shared value update
 * on every frame). The actual `seek()` call is deferred to pan-end so we
 * don't flood the audio engine with position changes.
 *
 * Tap (no significant horizontal movement) falls through to the same seek
 * callback as a drag-end.
 */
function Scrubber({
  progress,
  onSeek,
  trackColor,
  fillColor,
}: {
  progress: number; // 0..1
  onSeek: (progress: number) => void;
  trackColor: string;
  fillColor: string;
}) {
  // Track whether a pan is in progress. While dragging, `localProgress`
  // overrides `progress` so the thumb doesn't lag behind.
  const isDragging = useSharedValue(false);
  const localProgress = useSharedValue(progress);

  // Keep a ref so the pan gesture callbacks (worklets) can read the latest
  // onSeek without capturing a stale closure.
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;

  // Sync incoming `progress` only when not dragging.
  // We update localProgress from JS side on every render when not dragging.
  if (!isDragging.value) {
    localProgress.value = progress;
  }

  const panGesture = Gesture.Pan()
    .minDistance(0)
    .onBegin((e) => {
      "worklet";
      isDragging.value = true;
      localProgress.value = Math.max(0, Math.min(1, e.x / BAR_WIDTH));
    })
    .onUpdate((e) => {
      "worklet";
      localProgress.value = Math.max(0, Math.min(1, e.x / BAR_WIDTH));
    })
    .onEnd((e) => {
      "worklet";
      isDragging.value = false;
      const finalProgress = Math.max(0, Math.min(1, e.x / BAR_WIDTH));
      localProgress.value = finalProgress;
      // runOnJS to call the JS-side seek handler from the worklet.
      runOnJS(onSeekRef.current)(finalProgress);
    })
    .runOnJS(false);

  const tapGesture = Gesture.Tap()
    .onEnd((e) => {
      "worklet";
      const tappedProgress = Math.max(0, Math.min(1, e.x / BAR_WIDTH));
      runOnJS(onSeekRef.current)(tappedProgress);
    });

  const composed = Gesture.Race(panGesture, tapGesture);

  const fillStyle = useAnimatedStyle(() => ({
    width: localProgress.value * BAR_WIDTH,
  }));

  const thumbStyle = useAnimatedStyle(() => ({
    left: localProgress.value * BAR_WIDTH - THUMB_SIZE / 2,
  }));

  return (
    <GestureDetector gesture={composed}>
      <View
        style={styles.barContainer}
        accessibilityRole="adjustable"
        accessibilityLabel="Seek audio"
      >
        {/* Track */}
        <View style={[styles.barTrack, { backgroundColor: trackColor }]}>
          {/* Animated fill */}
          <Animated.View
            style={[styles.barFill, { backgroundColor: fillColor }, fillStyle]}
          />
        </View>
        {/* Thumb dot */}
        <Animated.View
          style={[styles.thumb, { backgroundColor: fillColor }, thumbStyle]}
        />
      </View>
    </GestureDetector>
  );
}

// ---------------------------------------------------------------------------
// Waveform
// ---------------------------------------------------------------------------

interface WaveformProps {
  /** 80 normalized floats (0..1) from server. Must be non-empty. */
  peaks: number[];
  /** Playback progress fraction 0..1. */
  progress: number;
  /** Called with a progress fraction (0..1); parent converts to ms. */
  onSeek: (fraction: number) => void;
  tintColor: string;
  fillColor: string;
}

/**
 * Waveform scrubber — two-layer approach for smooth playback animation.
 *
 * Layer 1: static row of 80 tinted bars (always rendered).
 * Layer 2: absolutely-positioned Animated.View with the same 80 fill bars.
 *          Its width is driven by a Reanimated shared value so the fill
 *          boundary moves without re-rendering any bar.
 *
 * Seek gesture is Gesture.Race(Pan, Tap) — identical pattern to Scrubber.
 */
function Waveform({
  peaks,
  progress,
  onSeek,
  tintColor,
  fillColor,
}: WaveformProps) {
  const isDragging = useSharedValue(false);
  const localProgress = useSharedValue(progress);

  // Keep a ref so worklets always invoke the latest onSeek from JS.
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;

  // Sync playback progress into the shared value only when not dragging.
  // We read isDragging.value synchronously here (JS side) — it's safe because
  // we only write it from worklets during an active gesture.
  if (!isDragging.value) {
    localProgress.value = progress;
  }

  const panGesture = Gesture.Pan()
    .minDistance(0)
    .onBegin((e) => {
      "worklet";
      isDragging.value = true;
      localProgress.value = Math.max(0, Math.min(1, e.x / WAVEFORM_TOTAL_WIDTH));
    })
    .onUpdate((e) => {
      "worklet";
      localProgress.value = Math.max(0, Math.min(1, e.x / WAVEFORM_TOTAL_WIDTH));
    })
    .onEnd((e) => {
      "worklet";
      isDragging.value = false;
      const fraction = Math.max(0, Math.min(1, e.x / WAVEFORM_TOTAL_WIDTH));
      localProgress.value = fraction;
      // Pass fraction to JS; parent converts to ms (same pattern as Scrubber).
      runOnJS(onSeekRef.current)(fraction);
    })
    .runOnJS(false);

  const tapGesture = Gesture.Tap().onEnd((e) => {
    "worklet";
    const fraction = Math.max(0, Math.min(1, e.x / WAVEFORM_TOTAL_WIDTH));
    runOnJS(onSeekRef.current)(fraction);
  });

  const composed = Gesture.Race(panGesture, tapGesture);

  const fillWidthStyle = useAnimatedStyle(() => ({
    width: localProgress.value * WAVEFORM_TOTAL_WIDTH,
  }));

  // Pre-compute bar heights once — peaks array is stable per message.
  const barHeights = peaks.map((p) =>
    Math.max(WAVEFORM_MIN_HEIGHT, p * WAVEFORM_MAX_HEIGHT),
  );

  const bars = (color: string) =>
    barHeights.map((h, i) => (
      <View
        key={i}
        style={{
          width: WAVEFORM_BAR_WIDTH,
          height: h,
          borderRadius: 1,
          backgroundColor: color,
          marginRight: i < WAVEFORM_BAR_COUNT - 1 ? WAVEFORM_GAP : 0,
          alignSelf: "center",
        }}
      />
    ));

  return (
    <GestureDetector gesture={composed}>
      <View
        style={{
          width: WAVEFORM_TOTAL_WIDTH,
          height: WAVEFORM_MAX_HEIGHT,
          flexDirection: "row",
          alignItems: "center",
        }}
        accessibilityRole="adjustable"
        accessibilityLabel="Seek audio"
      >
        {/* Layer 1 — tinted (unplayed) bars, always visible */}
        {bars(tintColor)}

        {/* Layer 2 — fill (played) bars masked by Animated width */}
        <Animated.View
          style={[
            {
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              overflow: "hidden",
              flexDirection: "row",
              alignItems: "center",
            },
            fillWidthStyle,
          ]}
          pointerEvents="none"
        >
          {bars(fillColor)}
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * Audio message bubble for voice memos and assistant TTS output.
 *
 * @param messageId           - Unique identifier for the chat_history row.
 * @param sessionId           - Active app session ID (for retry-transcription).
 * @param variant             - `"user"` (default) or `"assistant"`. The
 *                              assistant variant renders left-aligned with a
 *                              surface background and hides the transcription
 *                              accordion and retry CTA.
 * @param audioBlobUrl        - Relative blob URL to stream / cache.
 * @param audioDurationMs     - Duration hint shown before the player loads.
 * @param transcript          - STT output text shown as caption (user variant).
 * @param transcriptionStatus - `"transcribing" | "completed" | "failed"`.
 * @param transcriptionError  - Error detail shown when status is `"failed"`.
 */
export function AudioMessage({
  messageId,
  sessionId,
  variant = "user",
  audioBlobUrl,
  localAudioUri,
  audioDurationMs,
  transcript,
  transcriptionStatus,
  transcriptionError,
  audioPeaks,
}: AudioMessageProps) {
  // Source-of-truth URI for playback. Prefer the local file (instant +
  // works offline) — when the upload completes, the chat-store ID swaps
  // and a server `audioBlobUrl` arrives, but the local path stays valid
  // for the lifetime of the bubble.
  const playbackUri = localAudioUri ?? audioBlobUrl;
  const tokens = useThemeTokens();
  const pb = usePlaybackState();

  const isActive = pb.activeMessageId === messageId;
  const isPlaying = isActive && pb.status === "playing";
  const isLoading = isActive && pb.status === "loading";

  // Derive display values.
  const displayPositionMs = isActive ? pb.positionMs : 0;
  const displayDurationMs = isActive && pb.durationMs > 0 ? pb.durationMs : audioDurationMs;
  const progress =
    displayDurationMs > 0 ? displayPositionMs / displayDurationMs : 0;

  // Accordion open/closed state — collapsed by default.
  const [transcriptOpen, setTranscriptOpen] = useState(false);

  // Show-more state for long transcripts (inside the expanded accordion).
  const [captionExpanded, setCaptionExpanded] = useState(false);

  // Retry-transcription state.
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  const handlePlayPause = useCallback(() => {
    if (!playbackUri) return; // optimistic row not yet ready (shouldn't happen)
    if (isPlaying) {
      playbackController.pause();
    } else {
      void playbackController.play(messageId, playbackUri, audioDurationMs);
    }
  }, [isPlaying, messageId, playbackUri, audioDurationMs]);

  const handleSeek = useCallback(
    (fraction: number) => {
      const targetMs = Math.round(fraction * displayDurationMs);
      void playbackController.seek(targetMs);
    },
    [displayDurationMs],
  );

  const handleRetry = useCallback(async () => {
    setRetrying(true);
    setRetryError(null);
    try {
      await retryTranscription(sessionId, messageId);
      // Phase 4 will wire up chat refresh so the bubble updates automatically.
      // For now, indicate success optimistically via the local state reset.
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : "Retry failed");
    } finally {
      setRetrying(false);
    }
  }, [sessionId, messageId]);

  // ── Transcript accordion helpers ───────────────────────────────────────────

  const hasLongCaption =
    transcriptionStatus === "completed" && transcript.length > 160;

  // ── Layout ─────────────────────────────────────────────────────────────────

  // Assistant variant: left-aligned surface bubble (mirrors AssistantRow).
  // User variant: right-aligned ink bubble.
  const isAssistant = variant === "assistant";

  return (
    <View style={{ paddingHorizontal: 12, paddingVertical: 4, alignItems: isAssistant ? "flex-start" : "flex-end" }}>
      <View
        style={[
          styles.bubble,
          {
            backgroundColor: isAssistant ? tokens.surface : tokens.ink,
            borderWidth: isAssistant ? 1 : 0,
            borderColor: isAssistant ? tokens.line : undefined,
            // Fixed width regardless of accordion state. Calc:
            //   bubble pad-x = 24 (12+12)
            //   play button  = 34
            //   gap          = 10
            //   waveform     = 159 (80 bars × 1pt + 79 gaps × 1pt)
            //   gap          = 10
            //   duration     = ~50 (M:SS / M:SS)
            //   total        = 287, round to 295 for a small visual buffer.
            // Fits inside iPhone SE's 78% maxWidth chat-row constraint
            // (375pt × 0.78 ≈ 292) — bubble itself sits at the cap.
            // overflow:hidden so any sub-pixel rounding in the waveform
            // can't paint outside the bubble.
            width: 295,
            overflow: "hidden",
          },
        ]}
      >
        {/* ── Playback row ── */}
        <Row gap={10} align="center">
          {/* Play / Pause / Loading button */}
          <Pressable
            onPress={handlePlayPause}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={isPlaying ? "Pause audio" : "Play audio"}
            style={({ pressed }) => [
              styles.playBtn,
              {
                // Assistant: ink circle on surface bg. User: surface circle on ink bg.
                backgroundColor: isAssistant ? tokens.chip : tokens.surface,
                opacity: pressed ? 0.7 : 1,
              },
            ]}
          >
            {isLoading ? (
              <ActivityIndicator size="small" color={tokens.ink} />
            ) : (
              <Icon
                name={isPlaying ? "pause" : "play"}
                size={16}
                color={tokens.ink}
                stroke={2}
              />
            )}
          </Pressable>

          {/* Scrubber + duration */}
          <View style={styles.barAndTime}>
            {audioPeaks && audioPeaks.length > 0 ? (
              <Waveform
                peaks={audioPeaks}
                progress={progress}
                onSeek={handleSeek}
                tintColor={tokens.ink3}
                // User: filled bars are surface (light on dark). Assistant: ink (dark on light).
                fillColor={isAssistant ? tokens.ink : tokens.surface}
              />
            ) : (
              <Scrubber
                progress={progress}
                onSeek={handleSeek}
                trackColor={tokens.ink3}
                fillColor={isAssistant ? tokens.ink : tokens.surface}
              />
            )}
            <Text
              kind="caption"
              mono
              color={tokens.ink3}
              style={{ marginTop: 3, fontSize: 11 }}
            >
              {fmtMs(displayPositionMs)} / {fmtMs(displayDurationMs)}
            </Text>
          </View>
        </Row>

        {/* ── Transcription section (user variant only) ── */}

        {/* In-flight: show spinner row (not an accordion — user can't interact) */}
        {!isAssistant && transcriptionStatus === "transcribing" ? (
          <Row
            gap={6}
            align="center"
            style={{
              marginTop: 8,
              paddingTop: 8,
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: tokens.ink3,
            }}
          >
            <ActivityIndicator size="small" color={tokens.ink3} />
            <Text kind="caption" color={tokens.ink3} style={styles.italic}>
              Transcribing…
            </Text>
          </Row>
        ) : null}

        {/* Completed: collapsible accordion (user variant only — assistant text bubble carries transcript) */}
        {!isAssistant && transcriptionStatus === "completed" && transcript.length > 0 ? (
          <View
            style={{
              marginTop: 8,
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: tokens.ink3,
            }}
          >
            {/* Accordion header row */}
            <Pressable
              onPress={() => setTranscriptOpen((v) => !v)}
              accessibilityRole="button"
              accessibilityLabel={transcriptOpen ? "Collapse transcription" : "Expand transcription"}
              accessibilityState={{ expanded: transcriptOpen }}
              hitSlop={4}
              style={({ pressed }) => [
                styles.accordionHeader,
                { opacity: pressed ? 0.7 : 1 },
              ]}
            >
              <Text kind="caption" color={tokens.ink3}>
                Transcription
              </Text>
              <Icon
                name={transcriptOpen ? "chevU" : "chevD"}
                size={12}
                color={tokens.ink3}
              />
            </Pressable>

            {/* Expanded body */}
            {transcriptOpen ? (
              <View style={{ marginTop: 4, paddingBottom: 4 }}>
                <Text
                  kind="caption"
                  color={tokens.ink2}
                  numberOfLines={captionExpanded ? undefined : hasLongCaption ? 4 : undefined}
                  style={styles.italic}
                >
                  {transcript}
                </Text>
                {hasLongCaption && !captionExpanded ? (
                  <Pressable
                    onPress={() => setCaptionExpanded(true)}
                    hitSlop={4}
                    style={{ marginTop: 4 }}
                  >
                    <Text kind="caption" color={tokens.accent}>
                      Show more
                    </Text>
                  </Pressable>
                ) : null}
                {hasLongCaption && captionExpanded ? (
                  <Pressable
                    onPress={() => setCaptionExpanded(false)}
                    hitSlop={4}
                    style={{ marginTop: 4 }}
                  >
                    <Text kind="caption" color={tokens.accent}>
                      Show less
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </View>
        ) : null}

        {/* ── Retry CTA for failed transcriptions (user variant only) ── */}
        {!isAssistant && transcriptionStatus === "failed" ? (
          <Pressable
            onPress={() => void handleRetry()}
            disabled={retrying}
            accessibilityRole="button"
            accessibilityLabel="Retry transcription"
            style={({ pressed }) => [
              styles.retryPill,
              {
                backgroundColor: tokens.accentBg,
                borderColor: tokens.accent,
                opacity: pressed || retrying ? 0.6 : 1,
              },
            ]}
          >
            {retrying ? (
              <ActivityIndicator size="small" color={tokens.accent} />
            ) : (
              <Row gap={4} align="center">
                <Icon name="refresh" size={12} color={tokens.accent} />
                <Text kind="micro" color={tokens.accent}>
                  {retryError ?? "Retry transcription"}
                </Text>
              </Row>
            )}
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  bubble: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 18,
    // Match user bubble shape from Message.tsx (borderRadius: 18, maxWidth 78%).
  },
  playBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  barAndTime: {
    flex: 1,
  },
  barContainer: {
    width: BAR_WIDTH,
    height: 20,
    justifyContent: "center",
    // Extra hitSlop-equivalent height so small fingers can grab the scrubber.
  },
  barTrack: {
    height: 3,
    borderRadius: 1.5,
    overflow: "hidden",
  },
  barFill: {
    height: 3,
    borderRadius: 1.5,
    // Width is set dynamically via Animated.View inline style.
  },
  thumb: {
    position: "absolute",
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_SIZE / 2,
    // left is set dynamically via Animated.View inline style.
    // Vertically centred: barContainer height 20, thumb 10 → top = 5.
    top: (20 - THUMB_SIZE) / 2,
  },
  italic: {
    fontStyle: "italic",
  },
  accordionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 8,
    paddingBottom: 2,
  },
  retryPill: {
    marginTop: 8,
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    minHeight: 28,
    alignItems: "center",
    justifyContent: "center",
  },
});
