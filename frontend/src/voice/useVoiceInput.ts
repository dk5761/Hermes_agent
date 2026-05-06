/**
 * useVoiceInput — engine-routing hook for voice transcription.
 *
 * Phase 6: routes to either WhisperKit (useWhisperVoiceInput) or SFSpeech
 * (useSFSpeechVoiceInput) based on the user's `engine` setting and the current
 * WhisperKit model status.
 *
 * ### Engine resolution (auto mode)
 *
 * resolveEngine({ engine, modelStatus }) returns "whisper" | "sfspeech":
 *
 *   engine === "whisper"  → always "whisper" (user wants quality; caller gets
 *                           model_not_ready error if model absent)
 *   engine === "sfspeech" → always "sfspeech"
 *   engine === "auto":
 *     modelStatus === "ready"       → "whisper"
 *     modelStatus === "absent"      → "sfspeech" (model not downloaded yet)
 *     modelStatus === "downloading" → "sfspeech" (fall back for this call)
 *     modelStatus === "failed"      → "sfspeech" (automatic fallback; caller
 *                                     may show a transient notice)
 *     non-iOS platform              → "sfspeech" (WhisperKit iOS-only;
 *                                     theoretical since app is iOS-only)
 *
 * ### Hook routing strategy
 *
 * Conditionally calling hooks would break React's Rules of Hooks. Instead:
 *   1. Both useWhisperVoiceInput and useSFSpeechVoiceInput are called on every
 *      render with an `enabled` prop.
 *   2. The resolved engine is computed ONCE at hook construction from
 *      useVoiceSettings.getState() (snapshot, not reactive subscription) and
 *      stored in a ref — so it is stable for the lifetime of the hook.
 *   3. Only the active implementation has enabled=true; the other returns idle
 *      no-ops and registers no event subscriptions / audio session.
 *   4. If the user changes the engine setting while the hook is mounted, the
 *      change takes effect on the NEXT mount (e.g. after navigating away from
 *      and back to the chat screen). This is acceptable — the setting rarely
 *      changes, and a mid-session engine switch would be disruptive anyway.
 */

import { useRef } from "react";
import { Platform } from "react-native";
import { useVoiceSettings } from "@/state/voice-settings";
import type { VoiceEngine } from "@/state/voice-settings";
import { useWhisperVoiceInput } from "./internal/useWhisperVoiceInput";
import { useSFSpeechVoiceInput } from "./internal/useSFSpeechVoiceInput";
import { useWhisperModelState } from "./whisper-model-state";
import type { WhisperModelStatus } from "./whisper-model-state";
import type { UseVoiceInputOptions, UseVoiceInputResult } from "./types";

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

/**
 * Deterministically resolves which engine to use for a recording session.
 *
 * @param engine      - The user's preference from VoiceSettings.
 * @param modelStatus - Current WhisperKit model lifecycle status.
 * @returns "whisper" or "sfspeech"
 */
export function resolveEngine(opts: {
  engine: VoiceEngine;
  modelStatus: WhisperModelStatus;
}): "whisper" | "sfspeech" {
  const { engine, modelStatus } = opts;

  // Non-iOS: WhisperKit is unavailable — always SFSpeech.
  // (Theoretical; the app targets iOS only per app.json.)
  if (Platform.OS !== "ios") return "sfspeech";

  if (engine === "whisper") return "whisper";
  if (engine === "sfspeech") return "sfspeech";

  // engine === "auto": resolve from model readiness.
  switch (modelStatus) {
    case "ready":
      return "whisper";
    case "absent":
    case "downloading":
    case "failed":
      return "sfspeech";
    default:
      return "sfspeech";
  }
}

// ---------------------------------------------------------------------------
// Router hook
// ---------------------------------------------------------------------------

export function useVoiceInput(opts?: UseVoiceInputOptions): UseVoiceInputResult {
  // Snapshot the engine setting ONCE at construction — stable for hook lifetime.
  // See module-level comment for why we don't subscribe reactively here.
  const resolvedEngineRef = useRef<"whisper" | "sfspeech" | null>(null);

  if (resolvedEngineRef.current === null) {
    const { engine } = useVoiceSettings.getState();
    const modelStatus = useWhisperModelState.getState().status;
    resolvedEngineRef.current = resolveEngine({ engine, modelStatus });
  }

  const activeEngine = resolvedEngineRef.current;

  const addsPunctuation = useVoiceSettings((s) => s.addsPunctuation);

  const whisper = useWhisperVoiceInput({
    ...opts,
    enabled: activeEngine === "whisper",
  });

  const sfspeech = useSFSpeechVoiceInput({
    ...opts,
    enabled: activeEngine === "sfspeech",
    addsPunctuation,
  });

  return activeEngine === "whisper" ? whisper : sfspeech;
}
