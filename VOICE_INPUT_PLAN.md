# Voice Input — Phase-by-Phase Plan

**Status:** Design + plan. Not started. Captured 2026-05-04. Open questions resolved 2026-05-04 (see §5 — Locked decisions).

Add hold-to-talk voice input to the chat composer. Transcribes on-device via Apple's `SFSpeechRecognizer` (wrapped by `expo-speech-recognition`). $0 ongoing cost, audio never leaves the phone, ~half-day to ship the MVP.

---

## 1. Goal

User holds a mic button next to the chat input. Speech is transcribed live into the input field. User reviews + edits + sends. No per-message API cost. Privacy-preserving (on-device).

Stretch: tap-to-toggle as alternative interaction, settings preference, multi-language support.

## 2. Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│ ChatInput component                                                │
│  ┌─────────────────────────────────────┐ ┌──────┐ ┌──────────┐    │
│  │ TextInput (existing) ← transcript   │ │ Mic  │ │ Send     │    │
│  │                       inserted here │ │ btn  │ │ (existing)│    │
│  └─────────────────────────────────────┘ └──┬───┘ └──────────┘    │
│                                              │                      │
│                                              ▼ press / release     │
│                              ┌──────────────────────────────┐      │
│                              │ useVoiceInput() hook         │      │
│                              │  state: idle/rec/error       │      │
│                              │  start/stop/cancel methods   │      │
│                              └──────────────┬───────────────┘      │
│                                             │                       │
└─────────────────────────────────────────────┼───────────────────────┘
                                              │
                                              ▼
                              ┌────────────────────────────┐
                              │ ExpoSpeechRecognitionModule │
                              │ (expo-speech-recognition)   │
                              │ → SFSpeechRecognizer (iOS)  │
                              │ → on-device, $0 ongoing     │
                              └────────────────────────────┘
```

### Components to build

| Path | Purpose |
|---|---|
| `frontend/src/voice/permissions.ts` | Cached permission state, request flow, deep-link to Settings if denied |
| `frontend/src/voice/useVoiceInput.ts` | React hook: state machine (idle / recording / transcribing / error), live transcript, start/stop/cancel |
| `frontend/src/voice/MicButton.tsx` | Press-and-hold UI component, haptics, visual recording state |
| `frontend/src/voice/index.ts` | Barrel exports |
| `frontend/src/components/ChatInput.tsx` (extend) | Place MicButton next to Send |
| `frontend/app.json` (extend) | Add expo-speech-recognition plugin + permission strings |
| `frontend/app/(app)/(settings)/voice.tsx` (new, optional) | Settings: enabled toggle, interaction mode (PTT vs toggle), language preference |
| `frontend/src/state/settings.ts` (extend) | Persist voice prefs |

No backend changes. STT is fully on-device. The transcribed text follows the existing chat-message path (TextInput → Send → gateway WS).

---

## 3. Phases

### Phase 0 — Spike + risk vetting (1-2 hours)

**Goal:** confirm `expo-speech-recognition` builds + works on the existing Expo SDK 55 dev build.

Tasks:
- Install `expo-speech-recognition` in a throwaway branch
- Add Info.plist keys + plugin config in app.json
- Run `eas build --profile development --platform ios --local`
- Install on phone, request permissions, attempt one transcription
- Verify partial-results events fire (live preview will need them)
- Verify it co-exists with `expo-haptics`, `react-native-reanimated`, the iOS-tools native module

Acceptance: 30-line test page with a button that records 5s of speech and prints the transcript. Proves the chain works on this device + SDK.

Risks to validate:
- iOS 17/18 introduced new permission semantics (`NSSpeechRecognitionUsageDescription` still works but Apple is shifting to per-task entitlements in some flows — confirm)
- Module compatibility with `newArchEnabled: true` in app.json (Fabric/TurboModules)
- Concurrent audio sessions (Live Activity, in-app sounds, push notifications) — verify recording doesn't clash

Bail criteria: if Phase 0 hits a real blocker, fall back to **iOS keyboard mic button** (zero-effort, suboptimal UX, but $0 and works).

Files: throwaway `frontend/spike-voice/`, don't commit.

---

### Phase 1 — Install + permissions wiring (1 hour)

Files modified:
```
frontend/package.json                       # add expo-speech-recognition
frontend/app.json                            # plugin config + Info.plist keys
```

Permission strings (add to `expo.ios.infoPlist`):
- `NSSpeechRecognitionUsageDescription`: "Hermes uses speech recognition to transcribe your voice into chat messages. Audio stays on your device."
- `NSMicrophoneUsageDescription`: "Hermes needs the microphone to record your voice for dictation."

Both strings are required for App Store submission and shown by iOS on first request.

Plugin config:
```json
"plugins": [
  // ...
  ["expo-speech-recognition", {
    "speechRecognitionPermission": "Hermes uses speech recognition to transcribe your voice into chat messages. Audio stays on your device.",
    "microphonePermission": "Hermes needs the microphone to record your voice for dictation."
  }]
]
```

Acceptance: EAS dev build succeeds, app installs, no native crashes on launch.

---

### Phase 2 — Permission helper + voice hook (3-4 hours)

#### `frontend/src/voice/permissions.ts`

```ts
import * as ExpoSpeechRecognition from "expo-speech-recognition";
import { Linking } from "react-native";

export type VoicePermissionStatus = "granted" | "denied" | "not_determined" | "restricted";

export async function getStatus(): Promise<VoicePermissionStatus>;
export async function requestIfNeeded(): Promise<VoicePermissionStatus>;
export function openSettings(): Promise<void>;  // Wraps Linking.openSettings()
```

In-process cache so we don't re-prompt on every press. Handles both speech-recognition permission AND microphone permission (both required).

#### `frontend/src/voice/useVoiceInput.ts`

```ts
type VoiceState =
  | { kind: "idle" }
  | { kind: "requesting-permission" }
  | { kind: "recording"; partialTranscript: string }
  | { kind: "stopping" }
  | { kind: "error"; reason: "permission_denied" | "no_speech" | "audio_session" | "unknown"; message: string };

interface UseVoiceInputResult {
  state: VoiceState;
  transcript: string;          // final transcript from last completed recording
  start: () => Promise<void>;
  stop: () => Promise<void>;   // resolves when transcript is finalized
  cancel: () => void;          // discard current recording, no transcript event
  reset: () => void;           // clear last final transcript
}

export function useVoiceInput(opts?: { language?: string }): UseVoiceInputResult;
```

State machine handles:
- Permission request on first start
- Subscribing to `result` events (partial + final) from the module
- Stopping cleanly on `stop()` and waiting for the `end` event before resolving
- Cancel: stop without firing the final-transcript callback
- Error states: surface a meaningful `reason` so the UI can decide what to show

Default language: `en-US`. Configurable per-call via the hook arg, default settable in settings store.

Acceptance: a debug screen with three buttons (start / stop / cancel) and a text area showing partial + final transcripts. Verifies the hook is useful in isolation.

---

### Phase 3 — MicButton component (3-4 hours)

#### `frontend/src/voice/MicButton.tsx`

```tsx
interface MicButtonProps {
  onTranscript: (text: string) => void;     // fired on final transcript
  onPartial?: (text: string) => void;       // fired on partial (live preview)
  onError?: (err: VoiceError) => void;
  disabled?: boolean;
  mode?: "ptt" | "toggle";                  // default "ptt"
}
```

Behavior:
- **PTT mode (default):** `onPressIn` → `start()`, `onPressOut` → `stop()`. Slide finger off the button → `cancel()` (the standard iOS chat-app cancel gesture).
- **Toggle mode:** tap to start, tap again to stop. No cancel gesture.

Visual states:
- Idle: outlined mic icon, theme-default tint
- Recording: filled mic icon, red tint, subtle pulse animation (Reanimated 3)
- Error: mic icon with strikethrough, red, brief shake animation
- Disabled: dimmed

Haptics (using existing `expo-haptics`):
- Light impact on `start`
- Medium impact on `stop`
- Soft impact on `cancel`
- Error notification on permission denial

Permission denial UX: instead of just showing an error, show an inline alert with "Open Settings" button that calls `openSettings()`.

Acceptance: standalone storybook-style screen showing the button in all visual states + a debug overlay showing live transcript stream.

---

### Phase 4 — Wire into ChatInput (2 hours)

Find the existing chat composer (likely `frontend/app/(app)/(chats)/chat/[id].tsx` or a child component). Add `MicButton` next to the Send button.

```tsx
<View style={styles.composerRow}>
  <TextInput
    value={text + (partialTranscript ? ` ${partialTranscript}` : "")}
    onChangeText={setText}
    // ...
  />
  <MicButton
    onPartial={setPartialTranscript}
    onTranscript={(t) => setText((prev) => prev ? `${prev} ${t}` : t)}
    disabled={isStreamingResponse}
  />
  <SendButton ... />
</View>
```

Live preview: render `partialTranscript` greyed/italic appended to the current input value. On `onTranscript` (final), promote to the actual `text` state.

Edge cases:
- Recording while there's already typed text → append (with space)
- Recording while keyboard is open → leave keyboard alone, button still works
- Recording while the agent is streaming a response → disable mic (prevents accidental interleaving)
- Recording while a tool call is mid-flight → allow (user can dictate a follow-up while waiting)

Acceptance: real-device test of all 4 edge cases.

---

### Phase 5 — Settings + persistence (3-4 hours)

#### `frontend/app/(app)/(settings)/voice.tsx` (new screen)

Settings:
- **Voice input enabled** (toggle, default ON)
- **Interaction mode** (PTT / Tap-to-Toggle, default PTT)
- **Language** (en-US default, plus picker for common locales — leverages `ExpoSpeechRecognition.getSupportedLocales()`)
- **Add punctuation** (toggle, default ON — Apple's auto-punctuation)
- Link to system Settings → Hermes for permission management

Add to existing settings tab navigation.

#### `frontend/src/state/voice-settings.ts` (or extend existing settings)

Zustand store + AsyncStorage persistence for the four prefs above.

`useVoiceInput` reads `language` and `addPunctuation` from this store. `MicButton` reads `mode` and `enabled`.

Acceptance: change a setting, kill the app, reopen — setting persists. Toggle voice off → mic button hidden in chat input.

---

### Phase 6 — Polish + integration tests (2-3 hours)

Manual test scenarios (run on real device):

| # | Scenario | Expected |
|---|---|---|
| 1 | First-ever press → permission prompt → grant → record 3s | Permission flow smooth, transcript appears |
| 2 | Permission previously denied → press mic | Error UX shows "Open Settings" button; tapping deep-links correctly |
| 3 | Hold mic, speak, release | Final transcript inserted into TextInput, ready to send |
| 4 | Hold mic, slide finger off, release | Recording cancelled, no transcript inserted |
| 5 | Press mic while keyboard up | Recording works; keyboard stays |
| 6 | Long recording (30s+) | No crashes, full transcript captured, app responsive |
| 7 | Background app mid-recording | Recording stops cleanly; no zombie audio session |
| 8 | Language = es-ES, speak Spanish | Transcript in Spanish |
| 9 | Live preview while speaking | Partial text appears in real-time |
| 10 | Toggle mode (alt setting) | Tap → start, tap → stop. No cancel gesture |

Polish items:
- Tap target ≥ 44pt (iOS HIG)
- VoiceOver labels: "Voice input. Hold to record."
- Reduced-motion respect for the pulse animation
- Don't lock the screen while recording (set `keepAwake` if needed for very long captures — probably not)

Acceptance: all 10 scenarios pass on iPhone 14+.

---

### Phase 7 — Ship (30 min)

```bash
# Locally:
git push

# EAS production build (when ready):
cd frontend
eas build --profile production --platform ios

# Distribute via TestFlight, install on phone.
```

If using `--profile development` build that's already on phone, hot-reloading via Metro will work for the UI changes; native module needs a rebuild (which Phase 1 already shipped).

---

## 4. Total time estimate

| Phase | Hours |
|---|---|
| 0 — Spike | 1-2 |
| 1 — Install + permissions | 1 |
| 2 — Permission helper + voice hook | 3-4 |
| 3 — MicButton component | 3-4 |
| 4 — Wire into ChatInput | 2 |
| 5 — Settings + persistence | 3-4 |
| 6 — Polish + tests | 2-3 |
| 7 — Ship | 0.5 |
| **Total** | **~16-20 hours** |

About **2-3 focused days** of solo work. Add 50% buffer for surprises (permission edge cases, animation tuning, accessibility) → **~3-4 calendar days** end-to-end.

---

## 5. Risks + open questions

### High-risk

1. **Expo SDK 55 + new architecture compatibility.** `newArchEnabled: true` in app.json. Some Expo modules don't fully support Fabric yet — `expo-speech-recognition`'s readme as of 2026 should clarify. Validated in Phase 0.
2. **iOS 17/18 permission shifts.** Apple has been moving toward per-feature entitlements. The current `NSSpeechRecognitionUsageDescription` should still work but verify. Validated in Phase 0.

### Medium-risk

3. **Audio session conflicts** with Live Activity audio cues, push notification sounds, or in-app TTS playback. iOS audio sessions have categories (`AVAudioSession.Category`); recording typically wants `.record` or `.playAndRecord`. Verify it doesn't trample existing audio.
4. **Apple STT accuracy on technical terms.** Function names, MCP server names ("mcp-ios-tools"), command-line strings — Apple's STT may stumble. Workaround: surface a "Try again with cloud STT" affordance that hits Groq/Whisper API as fallback. Defer to v2 if it becomes a real problem.
5. **Battery / heat on long recordings.** SFSpeechRecognizer is on-device and modest, but pulse animation + audio capture costs power. Monitor in real use.

### Low-risk

6. **Mic button placement in composer.** Right of TextInput, left of Send is conventional. Risk: cramped on narrow screens (iPhone SE). Verify layout.
7. **VoiceOver / accessibility.** PTT gesture is harder for users with motor impairments. The "tap-to-toggle" mode covers them.
8. **Keyboard shortcut for voice on iPad with hardware keyboard.** Nice-to-have, not v1.

### Locked decisions (resolved 2026-05-04)

- **D1 — Interaction mode:** PTT (press-and-hold) is the default. Tap-to-toggle ships as an alt mode in settings. Slide-finger-off cancels (PTT only).
- **D2 — Live partial transcript:** show partial transcripts in real-time as the user speaks. Render greyed/italic appended to the input. Respect `prefers-reduced-motion` for the pulse animation around the mic button — but the partial-text update itself is unconditional (it's text, not motion).
- **D3 — Send flow:** **always require manual review.** Final transcript is inserted into the TextInput; user taps Send. No auto-send mode. STT errors are too common to skip the review step.
- **D4 — Default language:** detect from device locale via `Intl.getCanonicalLocales()` / `expo-localization`. Settings screen exposes an override picker (uses `ExpoSpeechRecognition.getSupportedLocales()` to populate). Persists across app restarts.

---

## 6. Stretch / future v2 ideas

Not in v1 but easy adds later:

- **Cloud STT fallback** — toggle in settings: "Use Whisper (Groq) for better accuracy on technical terms". Hits Groq Whisper Large v3 Turbo at $0.0007/min. ~30 min to wire because the chat input UX stays identical.
- **Voice-to-action shortcuts** — "Hey Hermes, add reminder X". Skips the chat composer entirely. Routes through `mcp-ios-tools` directly via a dedicated voice intent.
- **Continuous mode** — for longer dictation (notes, journal entries). Streams to a different surface, not the chat composer.
- **Per-chat voice mode** — some sessions are voice-first (driving), others are text-first (focused work). Per-session toggle.
- **Apple Watch dictation** — already discussed as a separate Watch-app project; this work would inform that.
- **Real-time agent-side transcription** — feed the audio stream directly to the agent (so it can interrupt or react mid-sentence). Way more complex; defer unless needed.

---

## 7. References

- [`expo-speech-recognition` (jamsch/expo-speech-recognition)](https://github.com/jamsch/expo-speech-recognition) — the npm module
- [Apple — `SFSpeechRecognizer` docs](https://developer.apple.com/documentation/speech/sfspeechrecognizer)
- [Apple — Speech framework permission requirements](https://developer.apple.com/documentation/speech/asking_permission_to_use_speech_recognition)
- [Expo modules guide](https://docs.expo.dev/modules/overview/) — for general native-module patterns
- Internal: `IOS_NATIVE_TOOLS_PLAN.md` — sibling design doc, similar EAS-build-required pattern
- Internal: `frontend/modules/HermesLiveActivity/` — existing native module precedent in this repo
- Groq Whisper pricing — for the v2 cloud-STT fallback

---

## 8. When to revisit

Re-read this doc before starting **Phase 0**. Specifically check:

- Has `expo-speech-recognition` had breaking changes? (Module is third-party, moves)
- Has Apple changed Speech framework permissions in iOS 18+?
- Is `newArchEnabled: true` still on in `app.json`?
- Has the chat composer been refactored since 2026-05-04?

If any answer is "yes, in a way that matters" → spend an extra hour in Phase 0 reverifying assumptions.
