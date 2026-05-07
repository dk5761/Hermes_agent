/**
 * Voice settings screen — `(app)/(settings)/voice`.
 *
 * VOICE_TRANSCRIBE_DISABLED: Sections B, C, D, F (language) are commented
 * out — they all relate to the transcribe-to-composer path (WhisperKit model,
 * engine picker, language override, addsPunctuation).
 *
 * Active sections:
 *   (A) Info card — voice memo notice (text updated)
 *   (E) Recording limits — local cap slider (memo length) + server cap slider
 *   (F-partial) General — voice enabled toggle only
 *   (G) Permissions — iOS Settings deep-link
 *   Reset button
 *
 * To restore all sections:
 *   1. Uncomment the VOICE_TRANSCRIBE_DISABLED blocks in this file.
 *   2. Restore imports: ExpoSpeechRecognitionModule, useWhisperModelState,
 *      resolveEngine, WhisperModelName.
 *   3. Re-enable transcribe-path props in MicButton / chat/[id].tsx.
 */
import { useCallback, useState } from "react";
// VOICE_TRANSCRIBE_DISABLED: useEffect (language-picker fetch), useMemo
// (languageLabel), Alert (model re-download/remove confirms) removed.
// To restore: add back to the import above.
import { ScrollView, View } from "react-native";
// VOICE_TRANSCRIBE_DISABLED: Pressable was used by EnginePicker and
// ModelPicker radio rows. Removed since both components are disabled.
// To restore: re-add Pressable to the react-native import above.
import { useRouter } from "expo-router";
// VOICE_TRANSCRIBE_DISABLED: ExpoSpeechRecognitionModule was used by the
// language picker (fetchSupportedLocales). Kept on disk; import removed here.
// import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";
// VOICE_TRANSCRIBE_DISABLED: Platform was used by EnginePicker
// (non-iOS platform check). Removed.
// import { Platform } from "react-native";
import Slider from "@react-native-community/slider";

import {
  Button,
  ListGroup,
  ListRow,
  NavBar,
  PhoneSafeArea,
  // VOICE_TRANSCRIBE_DISABLED: ProgressBar was used by ActiveModelCard download progress.
  // ProgressBar,
  // VOICE_TRANSCRIBE_DISABLED: Row was used by QualityDots (model picker). Removed.
  // Row,
  Stack,
  Text,
  Toggle,
  useThemeTokens,
} from "@/components/ui";
import {
  useVoiceSettings,
  LOCAL_CAP_RANGE,
  SERVER_CAP_RANGE,
} from "@/state/voice-settings";
// VOICE_TRANSCRIBE_DISABLED: VoiceEngine type was used by EnginePicker.
// import type { VoiceEngine } from "@/state/voice-settings";
// VOICE_TRANSCRIBE_DISABLED: useNetworkStatus was used by EnginePicker (online state).
// import { useNetworkStatus } from "@/state/network-status";
// VOICE_TRANSCRIBE_DISABLED: useWhisperModelState, resolveEngine, WhisperModelName
// were used by ActiveModelCard, ModelPicker, and EnginePicker.
// import { useWhisperModelState } from "@/voice/whisper-model-state";
// import { resolveEngine } from "@/voice/useVoiceInput";
// import type { WhisperModelName } from "whisperkit";
import { openVoiceSettings } from "@/voice";

/*
 * VOICE_TRANSCRIBE_DISABLED: CURATED_MODELS, language-picker helpers
 * (FALLBACK_LOCALES, resolveDeviceLocale, DEVICE_LOCALE, LocaleOption,
 * fetchSupportedLocales, buildLocaleOptions), ENGINE_OPTIONS, and EnginePicker
 * are all disabled. They provided:
 *   - CURATED_MODELS: the list of downloadable WhisperKit models shown in
 *     the model picker UI.
 *   - Language picker helpers: fetched iOS-supported speech locales, built a
 *     sorted picker list with device-default as the first entry.
 *   - ENGINE_OPTIONS + EnginePicker: radio picker for auto / whisper /
 *     sfspeech / server engines, fallback toggle, addsPunctuation toggle,
 *     and a "currently using" label derived from resolveEngine().
 *
 * To restore: uncomment this block and the corresponding imports above.
 *
 * interface ModelOption { ... }
 * const CURATED_MODELS: ReadonlyArray<ModelOption> = [ ... ];
 *
 * const FALLBACK_LOCALES = [ "en-US", ... ];
 * function resolveDeviceLocale(): string { ... }
 * const DEVICE_LOCALE = resolveDeviceLocale();
 * interface LocaleOption { value: string | null; label: string; }
 * async function fetchSupportedLocales(): Promise<ReadonlyArray<string>> { ... }
 * function buildLocaleOptions(supportedLocales): ReadonlyArray<LocaleOption> { ... }
 *
 * interface EngineOption { value: VoiceEngine; label: string; detail: string; }
 * const ENGINE_OPTIONS: ReadonlyArray<EngineOption> = [ ... ];
 * function EnginePicker() { ... }
 */

// ---------------------------------------------------------------------------
// Helpers for cap display
// ---------------------------------------------------------------------------

/** Format seconds as "{n}s" or "{m}m {s}s" when >= 60. */
function formatCapSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
}

// ---------------------------------------------------------------------------
// Recording limits card
// ---------------------------------------------------------------------------

function RecordingLimitsCard() {
  const tokens = useThemeTokens();

  const localCapSeconds = useVoiceSettings((s) => s.localCapSeconds);
  const serverCapSeconds = useVoiceSettings((s) => s.serverCapSeconds);
  const setLocalCapSeconds = useVoiceSettings((s) => s.setLocalCapSeconds);
  const setServerCapSeconds = useVoiceSettings((s) => s.setServerCapSeconds);

  // Local state mirrors the slider thumb during drag; the store write
  // fires only on slide-complete to avoid spamming SQLite on every tick.
  const [localDraft, setLocalDraft] = useState<number>(localCapSeconds);
  const [serverDraft, setServerDraft] = useState<number>(serverCapSeconds);

  return (
    <ListGroup
      header="Recording limits"
      footer="Recordings auto-stop at the limit. Captured audio is still transcribed."
    >
      {/* Local engines (WhisperKit, Apple) cap */}
      <View style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 6 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text kind="body-lg">Local engines (WhisperKit, Apple)</Text>
          <Text kind="label" style={{ color: tokens.accent }}>
            {formatCapSeconds(localDraft)}
          </Text>
        </View>
        <Text kind="caption" className="text-ink-3">
          Recordings auto-stop at this limit. Captured audio is still transcribed.
        </Text>
        <Slider
          minimumValue={LOCAL_CAP_RANGE.min}
          maximumValue={LOCAL_CAP_RANGE.max}
          step={5}
          value={localDraft}
          minimumTrackTintColor={tokens.accent}
          maximumTrackTintColor={tokens.lineSoft}
          thumbTintColor={tokens.accent}
          onValueChange={(v: number) => setLocalDraft(Math.round(v))}
          onSlidingComplete={(v: number) => {
            const rounded = Math.round(v);
            setLocalDraft(rounded);
            setLocalCapSeconds(rounded);
          }}
          accessibilityLabel="Local engine recording limit"
        />
      </View>

      <View
        style={{
          height: 1,
          backgroundColor: tokens.lineSoft,
          marginHorizontal: 16,
        }}
      />

      {/* Hermes server cap */}
      <View style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 6 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text kind="body-lg">Hermes server</Text>
          <Text kind="label" style={{ color: tokens.accent }}>
            {formatCapSeconds(serverDraft)}
          </Text>
        </View>
        <Text kind="caption" className="text-ink-3">
          Server recordings can be longer than on-device.
        </Text>
        <Slider
          minimumValue={SERVER_CAP_RANGE.min}
          maximumValue={SERVER_CAP_RANGE.max}
          step={30}
          value={serverDraft}
          minimumTrackTintColor={tokens.accent}
          maximumTrackTintColor={tokens.lineSoft}
          thumbTintColor={tokens.accent}
          onValueChange={(v: number) => setServerDraft(Math.round(v))}
          onSlidingComplete={(v: number) => {
            const rounded = Math.round(v);
            setServerDraft(rounded);
            setServerCapSeconds(rounded);
          }}
          accessibilityLabel="Server engine recording limit"
        />
      </View>
    </ListGroup>
  );
}

/*
 * VOICE_TRANSCRIBE_DISABLED: QualityDots, StatusBadge, ActiveModelCard, and
 * ModelPicker are all disabled. They provided:
 *   - QualityDots: 1–3 dot quality indicator for WhisperKit model variants.
 *   - StatusBadge: colored badge showing ready / downloading / absent / failed.
 *   - ActiveModelCard: shows the current WhisperKit model name, size, download
 *     status (with progress bar), and download/re-download/remove buttons.
 *   - ModelPicker: radio list of CURATED_MODELS for selecting the active model.
 *
 * To restore: uncomment this block and the imports for useWhisperModelState,
 * WhisperModelName, ProgressBar, CURATED_MODELS.
 *
 * function QualityDots(...) { ... }
 * type BadgeVariant = ...;
 * function StatusBadge(...) { ... }
 * function ActiveModelCard() { ... }
 * function ModelPicker() { ... }
 */

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function VoiceSettingsScreen() {
  const router = useRouter();
  const tokens = useThemeTokens();

  const enabled = useVoiceSettings((s) => s.enabled);
  const setEnabled = useVoiceSettings((s) => s.setEnabled);

  /*
   * VOICE_TRANSCRIBE_DISABLED: language and setLanguage, localeOptions,
   * pickerOpen, the fetchSupportedLocales effect, onSelectLocale, and
   * languageLabel were used by the language picker (section F).
   * Language is now auto-detected by faster-whisper on the server.
   *
   * To restore: uncomment this block and re-add the Language section in the JSX.
   *
   * const language = useVoiceSettings((s) => s.language);
   * const setLanguage = useVoiceSettings((s) => s.setLanguage);
   * const [localeOptions, setLocaleOptions] = useState<ReadonlyArray<LocaleOption>>([]);
   * const [pickerOpen, setPickerOpen] = useState(false);
   * useEffect(() => {
   *   void fetchSupportedLocales().then((locales) => {
   *     setLocaleOptions(buildLocaleOptions(locales));
   *   });
   * }, []);
   * const onSelectLocale = useCallback((value: string | null) => {
   *   setLanguage(value);
   *   setPickerOpen(false);
   * }, [setLanguage]);
   * const languageLabel = useMemo(() => {
   *   if (language === null) return `Device default (${DEVICE_LOCALE})`;
   *   return language;
   * }, [language]);
   */

  const onManageInSettings = useCallback(() => {
    void openVoiceSettings();
  }, []);

  return (
    <PhoneSafeArea>
      <NavBar title="Voice input" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 60 }}>
        <Stack gap={18}>
          {/* ── Info card ──────────────────────────────────────────── */}
          <View
            className="bg-surface border border-line"
            style={{ marginHorizontal: 16, padding: 14, borderRadius: 12 }}
          >
            <Stack gap={4}>
              <Text kind="label">Voice memos</Text>
              <Text kind="caption" className="text-ink-3">
                Tap the mic button to record a voice memo. Tap again to send.
                Hold for PTT (push-to-talk): release to send, slide to cancel.
                Audio is uploaded to your self-hosted Hermes server for
                transcription.
              </Text>
            </Stack>
          </View>

          {/*
            * VOICE_TRANSCRIBE_DISABLED: Active model card (B) — WhisperKit model
            * status, download progress, re-download/remove buttons.
            * To restore: uncomment <ActiveModelCard /> and its Stack wrapper.
            *
            * <Stack gap={8}>
            *   <Text kind="micro" className="text-ink-3 uppercase" style={{ paddingHorizontal: 16 }}>
            *     Active model
            *   </Text>
            *   <ActiveModelCard />
            * </Stack>
            */}

          {/*
            * VOICE_TRANSCRIBE_DISABLED: Model picker (C) — curated WhisperKit
            * model variants with radio selection.
            * To restore: uncomment <ModelPicker />.
            *
            * <ModelPicker />
            */}

          {/*
            * VOICE_TRANSCRIBE_DISABLED: Engine picker (D) — auto / whisper /
            * sfspeech / server radio, fallback toggle, addsPunctuation toggle,
            * and "currently using" label.
            * To restore: uncomment <EnginePicker />.
            *
            * <EnginePicker />
            */}

          {/* ── Recording limits ───────────────────────────────────── */}
          <RecordingLimitsCard />

          {/* ── General ────────────────────────────────────────────── */}
          <ListGroup header="General">
            <ListRow
              icon="mic"
              title="Voice input"
              subtitle="Show the microphone button in the chat composer"
              right={<Toggle on={enabled} onChange={setEnabled} />}
            />
          </ListGroup>

          {/*
            * VOICE_TRANSCRIBE_DISABLED: Language picker (F) — recognition
            * language override. Language is now auto-detected by faster-whisper
            * on the server.
            * To restore: uncomment this block and re-add language state above.
            *
            * <ListGroup
            *   header="Language"
            *   footer="Override the speech recognition language. Device default uses your system locale."
            * >
            *   <ListRow
            *     icon="globe"
            *     title="Recognition language"
            *     detail={languageLabel}
            *     chevron
            *     onPress={() => setPickerOpen((prev) => !prev)}
            *   />
            *   {pickerOpen ? ( ... locale list ... ) : null}
            * </ListGroup>
            */}

          {/* ── Permissions ────────────────────────────────────────── */}
          <ListGroup
            header="Permissions"
            footer="Manage microphone access for Hermes in iOS Settings."
          >
            <ListRow
              icon="shieldCheck"
              title="Manage in iOS Settings"
              subtitle="Change microphone permissions"
              chevron
              onPress={onManageInSettings}
            />
          </ListGroup>

          {/* ── Reset ──────────────────────────────────────────────── */}
          <Stack style={{ paddingHorizontal: 16 }}>
            <Button
              kind="secondary"
              leftIcon="refresh"
              onClick={() => {
                useVoiceSettings.getState().reset();
              }}
            >
              Reset voice settings
            </Button>
          </Stack>
        </Stack>
      </ScrollView>
    </PhoneSafeArea>
  );
}
