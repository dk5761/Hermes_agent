/**
 * useVoiceInput — engine-routing hook for voice transcription.
 *
 * Phase 6: routes to WhisperKit (useWhisperVoiceInput), SFSpeech
 * (useSFSpeechVoiceInput), or the Hermes server (useServerVoiceInput) based
 * on the user's `engine` setting, the current WhisperKit model status, and the
 * device's online state.
 *
 * ### Engine resolution
 *
 * resolveEngine({ engine, modelStatus, online, fallbackOnOffline }) is a pure
 * function that returns one of: "whisper" | "sfspeech" | "server" | "blocked"
 *
 * Rule table (evaluated top-to-bottom, first match wins):
 *
 *   1.  non-iOS platform                                           → "sfspeech"
 *       (WhisperKit iOS-only; theoretical since app targets iOS)
 *   2.  engine === "whisper"                                       → "whisper"
 *   3.  engine === "sfspeech"                                      → "sfspeech"
 *   4.  engine === "server" + online                               → "server"
 *   5.  engine === "server" + !online + fallbackOnOffline + ready  → "whisper"
 *   6.  engine === "server" + !online + fallbackOnOffline + !ready → "sfspeech"
 *   7.  engine === "server" + !online + !fallbackOnOffline         → "blocked"
 *   8.  engine === "auto"   + modelStatus === "ready"              → "whisper"
 *       (online or offline — on-device model is always usable)
 *   9.  engine === "auto"   + modelStatus !== "ready"              → "sfspeech"
 *
 * "blocked" means the user explicitly chose server-only and is offline.
 * The hook surfaces this as an immediate error state (kind "server_unavailable_offline")
 * without registering any audio resources.
 *
 * ### Hook routing strategy
 *
 * Conditionally calling hooks would break React's Rules of Hooks. Instead:
 *   1. useWhisperVoiceInput, useSFSpeechVoiceInput, and useServerVoiceInput are
 *      called on every render with an `enabled` prop.
 *   2. The resolved engine is computed ONCE at hook construction from
 *      useVoiceSettings.getState() + useNetworkStatus.getState() (snapshots, not
 *      reactive subscriptions) and stored in a ref — stable for hook lifetime.
 *   3. Only the active implementation has enabled=true; the others return idle
 *      no-ops and register no event subscriptions / audio session.
 *   4. If the user changes the engine setting or goes offline while the hook is
 *      mounted, the change takes effect on the NEXT mount (e.g. after navigating
 *      away from and back to the chat screen). This is acceptable — the setting
 *      rarely changes, and a mid-session engine switch would be disruptive.
 *
 * ### Cap timer
 *
 * A single useEffect in this router enforces the recording cap:
 *   - whisper / sfspeech: localCapSeconds (default 60)
 *   - server: serverCapSeconds (default 300)
 *   - blocked / idle / transcribing: no timer
 *
 * When the cap fires, stop() is called (not cancel()) so captured audio is
 * delivered and onFinalTranscript fires. capExceededAt is set to Date.now() so
 * consumers can show a toast via a useEffect on that value.
 */

import { useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { useVoiceSettings } from "@/state/voice-settings";
import type { VoiceEngine } from "@/state/voice-settings";
import { useNetworkStatus } from "@/state/network-status";
import { useWhisperVoiceInput } from "./internal/useWhisperVoiceInput";
import { useSFSpeechVoiceInput } from "./internal/useSFSpeechVoiceInput";
import { useServerVoiceInput } from "./internal/useServerVoiceInput";
import { useWhisperModelState } from "./whisper-model-state";
import type { WhisperModelStatus } from "./whisper-model-state";
import type {
  UseVoiceInputOptions,
  UseVoiceInputResult,
  VoiceInputError,
  VoiceInputState,
} from "./types";

// ---------------------------------------------------------------------------
// Public types — re-exported for downstream consumers that import from "@/voice"
// ---------------------------------------------------------------------------

export type {
  VoiceInputError,
  VoiceInputState,
  UseVoiceInputOptions,
  UseVoiceInputResult,
} from "./types";

// ---------------------------------------------------------------------------
// Engine resolver
// ---------------------------------------------------------------------------

/** All possible resolved outcomes from resolveEngine. */
export type ResolvedEngine = "whisper" | "sfspeech" | "server" | "blocked";

export interface ResolveEngineInput {
  engine: VoiceEngine;
  modelStatus: WhisperModelStatus;
  /** Device network reachability from useNetworkStatus. */
  online: boolean;
  /**
   * When true: engine="server" + offline falls back to an on-device engine.
   * When false: engine="server" + offline resolves to "blocked".
   */
  fallbackOnOffline: boolean;
}

/**
 * Deterministically resolves which engine to use for a recording session.
 *
 * Pure function — reads no external state; all inputs are passed explicitly.
 *
 * Rule table (top-to-bottom, first match wins):
 *   1.  non-iOS                                            → "sfspeech"
 *   2.  engine === "whisper"                               → "whisper"
 *   3.  engine === "sfspeech"                              → "sfspeech"
 *   4.  engine === "server" + online                       → "server"
 *   5.  engine === "server" + !online + fallback + ready   → "whisper"
 *   6.  engine === "server" + !online + fallback + !ready  → "sfspeech"
 *   7.  engine === "server" + !online + !fallback          → "blocked"
 *   8.  engine === "auto"   + modelStatus === "ready"      → "whisper"
 *   9.  engine === "auto"   + otherwise                    → "sfspeech"
 *
 * @param opts - Resolution inputs (all explicit, no side-effects).
 * @returns The concrete engine to activate, or "blocked" when the user opted
 *          out of fallback and the server engine is unavailable.
 */
export function resolveEngine(opts: ResolveEngineInput): ResolvedEngine {
  const { engine, modelStatus, online, fallbackOnOffline } = opts;

  // Rule 1 — Non-iOS: WhisperKit unavailable; SFSpeech is the only option.
  if (Platform.OS !== "ios") return "sfspeech";

  // Rule 2 — Explicit whisper preference.
  if (engine === "whisper") return "whisper";

  // Rule 3 — Explicit SFSpeech preference.
  if (engine === "sfspeech") return "sfspeech";

  // Rules 4-7 — Server engine.
  if (engine === "server") {
    if (online) return "server";                                          // 4
    if (fallbackOnOffline) {
      return modelStatus === "ready" ? "whisper" : "sfspeech";           // 5 / 6
    }
    return "blocked";                                                     // 7
  }

  // Rules 8-9 — Auto mode: pick by model readiness.
  // Online state does not affect auto mode — on-device engines work offline.
  return modelStatus === "ready" ? "whisper" : "sfspeech";               // 8 / 9
}

// ---------------------------------------------------------------------------
// Blocked-engine stub constants
// ---------------------------------------------------------------------------

const BLOCKED_ERROR: VoiceInputError = {
  kind: "server_unavailable_offline",
  message: "Server transcription requires a network connection.",
};

const BLOCKED_STATE: VoiceInputState = {
  kind: "error",
  error: BLOCKED_ERROR,
};

const NOOP = async (): Promise<void> => undefined;
const NOOP_SYNC = (): void => undefined;

// ---------------------------------------------------------------------------
// Router hook
// ---------------------------------------------------------------------------

export function useVoiceInput(opts?: UseVoiceInputOptions): UseVoiceInputResult {
  // -------------------------------------------------------------------------
  // Engine resolution — snapshot ONCE at construction; stable for hook lifetime.
  // See module-level comment for why we don't subscribe reactively.
  // -------------------------------------------------------------------------
  const resolvedEngineRef = useRef<ResolvedEngine | null>(null);

  if (resolvedEngineRef.current === null) {
    const { engine, fallbackOnOffline } = useVoiceSettings.getState();
    const modelStatus = useWhisperModelState.getState().status;
    const online = useNetworkStatus.getState().online;
    resolvedEngineRef.current = resolveEngine({
      engine,
      modelStatus,
      online,
      fallbackOnOffline,
    });
  }

  const activeEngine = resolvedEngineRef.current;

  // -------------------------------------------------------------------------
  // Settings reads — reactive subscriptions for values used at render time.
  // localCapSeconds / serverCapSeconds read from getState() inside the effect
  // so we don't re-run the effect on every slider change.
  // -------------------------------------------------------------------------
  const addsPunctuation = useVoiceSettings((s) => s.addsPunctuation);

  // -------------------------------------------------------------------------
  // Cap-exceeded timestamp — null until cap fires, reset on next start.
  // -------------------------------------------------------------------------
  const [capExceededAt, setCapExceededAt] = useState<number | null>(null);

  // -------------------------------------------------------------------------
  // Internal hooks — all three are always called (Rules of Hooks).
  // Only the active engine gets enabled=true.
  // -------------------------------------------------------------------------
  const whisper = useWhisperVoiceInput({
    ...opts,
    enabled: activeEngine === "whisper",
  });

  const sfspeech = useSFSpeechVoiceInput({
    ...opts,
    enabled: activeEngine === "sfspeech",
    addsPunctuation,
  });

  const server = useServerVoiceInput({
    ...opts,
    enabled: activeEngine === "server",
  });

  // Select the active result. For "blocked" we use a fixed stub so the cap
  // timer hooks below still see a stable `state` and `stop` reference.
  const isBlocked = activeEngine === "blocked";

  const active: UseVoiceInputResult = isBlocked
    ? {
        state: BLOCKED_STATE,
        transcript: "",
        partialTranscript: "",
        isListening: false,
        error: BLOCKED_ERROR,
        modelStatus: "ready",
        modelProgress: 1,
        start: NOOP,
        stop: NOOP,
        cancel: NOOP_SYNC,
        reset: NOOP_SYNC,
        ensureModelReady: NOOP,
        capExceededAt: null,
      }
    : activeEngine === "whisper"
      ? whisper
      : activeEngine === "server"
        ? server
        : sfspeech;

  // -------------------------------------------------------------------------
  // Cap timer — fires stop() when recording exceeds the configured limit.
  //
  // Runs in the parent router (not in each child hook) so cap behaviour is
  // identical across engines without duplicating the logic. A single effect
  // watches state.kind + the resolved engine; it re-arms on every transition
  // into "recording" and cleans up on any exit.
  //
  // Why read cap from getState() inside the effect rather than subscribing:
  //   The user changes the cap via a slider (Phase 5). We intentionally do NOT
  //   want the timer to restart mid-recording just because the slider moved —
  //   that would be confusing. The cap that was in place when recording started
  //   applies for that session. Reading getState() at effect setup captures
  //   the value at recording-start time, which is exactly what we want.
  // -------------------------------------------------------------------------
  const { state, stop } = active;

  // Use a ref for stop so the effect's cleanup closure always calls the latest
  // version without needing stop in the dependency array.
  const stopRef = useRef(stop);
  stopRef.current = stop;

  useEffect(() => {
    // No cap for blocked engine (stub stop is a no-op anyway, but skip the timer).
    if (isBlocked) return;
    if (state.kind !== "recording") return;

    const settings = useVoiceSettings.getState();
    const capMs =
      activeEngine === "server"
        ? settings.serverCapSeconds * 1000
        : settings.localCapSeconds * 1000;

    const timer = setTimeout(() => {
      setCapExceededAt(Date.now());
      void stopRef.current();
    }, capMs);

    return () => clearTimeout(timer);
  }, [state.kind, activeEngine, isBlocked]);

  // Reset capExceededAt when a new recording session starts (state enters "recording").
  // Using useEffect (not synchronous render-time setState) to avoid React warnings.
  useEffect(() => {
    if (state.kind === "recording") {
      setCapExceededAt(null);
    }
  }, [state.kind]);

  return { ...active, capExceededAt };
}
