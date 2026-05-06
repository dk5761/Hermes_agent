/**
 * Voice settings screen — `(app)/(settings)/voice`.
 *
 * Sections:
 *   (A) Info card — on-device transcription notice
 *   (B) Active model card — status badge, progress bar, action buttons
 *   (C) Model picker — curated WhisperKit variants with radio selection
 *   (D) Speech recognition engine — engine radio + addsPunctuation + current label
 *   (E) General — voice enabled toggle, interaction mode, language picker
 *   (F) Permissions — iOS Settings deep-link
 *
 * Layout mirrors notifications.tsx: NavBar + ScrollView + ListGroup sections.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";
import { Platform } from "react-native";

import {
  Button,
  ListGroup,
  ListRow,
  NavBar,
  PhoneSafeArea,
  ProgressBar,
  Row,
  SegControl,
  Stack,
  Text,
  Toggle,
  useThemeTokens,
} from "@/components/ui";
import { useVoiceSettings } from "@/state/voice-settings";
import type { VoiceEngine } from "@/state/voice-settings";
import { useWhisperModelState } from "@/voice/whisper-model-state";
import { resolveEngine } from "@/voice/useVoiceInput";
import type { WhisperModelName } from "whisperkit";
import { openVoiceSettings } from "@/voice";

// ---------------------------------------------------------------------------
// Curated model picker list
// ---------------------------------------------------------------------------

interface ModelOption {
  name: WhisperModelName;
  label: string;
  sizeLabel: string;
  /** 1 = OK, 2 = Good, 3 = Best */
  qualityTier: 1 | 2 | 3;
  note?: string;
  isDefault?: boolean;
}

const CURATED_MODELS: ReadonlyArray<ModelOption> = [
  {
    name: "openai_whisper-tiny.en",
    label: "Tiny (English)",
    sizeLabel: "~75 MB",
    qualityTier: 1,
  },
  {
    name: "openai_whisper-base.en",
    label: "Base (English)",
    sizeLabel: "~140 MB",
    qualityTier: 2,
    isDefault: true,
  },
  {
    name: "openai_whisper-base",
    label: "Base (Multilingual)",
    sizeLabel: "~140 MB",
    qualityTier: 2,
  },
  {
    name: "openai_whisper-small.en",
    label: "Small (English)",
    sizeLabel: "~466 MB",
    qualityTier: 3,
    note: "Slow on older iPhones",
  },
] as const;

// ---------------------------------------------------------------------------
// Language picker helpers
// ---------------------------------------------------------------------------

/** Fallback locale list shown if getSupportedLocales throws or returns empty. */
const FALLBACK_LOCALES: ReadonlyArray<string> = [
  "en-US",
  "en-GB",
  "en-IN",
  "es-ES",
  "fr-FR",
  "de-DE",
  "ja-JP",
  "zh-CN",
];

function resolveDeviceLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale ?? "en-US";
  } catch {
    return "en-US";
  }
}

const DEVICE_LOCALE = resolveDeviceLocale();

interface LocaleOption {
  value: string | null; // null = device default
  label: string;
}

async function fetchSupportedLocales(): Promise<ReadonlyArray<string>> {
  try {
    const result = await ExpoSpeechRecognitionModule.getSupportedLocales({
      androidRecognitionServicePackage: undefined,
    });
    const locales = result?.locales;
    if (Array.isArray(locales) && locales.length > 0) {
      return locales;
    }
    return FALLBACK_LOCALES;
  } catch {
    return FALLBACK_LOCALES;
  }
}

function buildLocaleOptions(
  supportedLocales: ReadonlyArray<string>,
): ReadonlyArray<LocaleOption> {
  const deviceDefault: LocaleOption = {
    value: null,
    label: `Device default (${DEVICE_LOCALE})`,
  };

  const set = new Set(supportedLocales);
  set.add(DEVICE_LOCALE);
  const sorted = Array.from(set).sort((a, b) => a.localeCompare(b));

  return [
    deviceDefault,
    ...sorted.map((loc) => ({ value: loc, label: loc })),
  ];
}

// ---------------------------------------------------------------------------
// Engine picker
// ---------------------------------------------------------------------------

interface EngineOption {
  value: VoiceEngine;
  label: string;
  detail: string;
}

const ENGINE_OPTIONS: ReadonlyArray<EngineOption> = [
  {
    value: "auto",
    label: "Auto (recommended)",
    detail: "Uses WhisperKit when ready, otherwise Apple system recognition.",
  },
  {
    value: "whisper",
    label: "WhisperKit only",
    detail: "On-device ML model. Requires a downloaded model.",
  },
  {
    value: "sfspeech",
    label: "Apple system (SFSpeech)",
    detail: "Always available. No download required.",
  },
] as const;

function EnginePicker() {
  const tokens = useThemeTokens();
  const engine = useVoiceSettings((s) => s.engine);
  const addsPunctuation = useVoiceSettings((s) => s.addsPunctuation);
  const setEngine = useVoiceSettings((s) => s.setEngine);
  const setAddsPunctuation = useVoiceSettings((s) => s.setAddsPunctuation);
  const modelStatus = useWhisperModelState((s) => s.status);
  const activeModel = useWhisperModelState((s) => s.activeModel);

  // Derive which engine is actually active right now for the status label.
  const effectiveEngine = resolveEngine({ engine, modelStatus });

  const modelOption = CURATED_MODELS.find((m) => m.name === activeModel);
  const modelFriendlyName = modelOption?.label ?? activeModel;

  const currentEngineLabel =
    effectiveEngine === "whisper"
      ? `WhisperKit — ${modelFriendlyName}`
      : "Apple SFSpeech";

  // Show the addsPunctuation toggle only when SFSpeech is the active engine.
  const showPunctuationToggle = effectiveEngine === "sfspeech";

  const handleSelect = useCallback(
    (value: VoiceEngine) => {
      setEngine(value);
    },
    [setEngine],
  );

  return (
    <ListGroup
      header="Speech recognition engine"
      footer="Auto uses WhisperKit when the model is downloaded and ready, falling back to Apple's built-in recognizer otherwise."
    >
      {ENGINE_OPTIONS.map((opt) => {
        const isActive = opt.value === engine;
        return (
          <Pressable
            key={opt.value}
            onPress={() => handleSelect(opt.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected: isActive }}
            style={{
              paddingVertical: 12,
              paddingHorizontal: 16,
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
            }}
          >
            {/* Radio indicator */}
            <View
              style={{
                width: 18,
                height: 18,
                borderRadius: 9,
                borderWidth: 2,
                borderColor: isActive ? tokens.accent : tokens.line,
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              {isActive ? (
                <View
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    backgroundColor: tokens.accent,
                  }}
                />
              ) : null}
            </View>

            {/* Label block */}
            <View style={{ flex: 1, gap: 2 }}>
              <Text
                kind="body-lg"
                style={{ fontWeight: isActive ? "600" : "400" }}
              >
                {opt.label}
              </Text>
              <Text kind="caption" className="text-ink-3">
                {opt.detail}
              </Text>
            </View>
          </Pressable>
        );
      })}

      {/* Punctuation toggle — only visible when SFSpeech is effective engine */}
      {showPunctuationToggle ? (
        <ListRow
          icon="hash"
          title="Auto-punctuation"
          subtitle="Adds commas and periods automatically (SFSpeech only)"
          right={
            <Toggle on={addsPunctuation} onChange={setAddsPunctuation} />
          }
        />
      ) : null}

      {/* Currently-active engine label */}
      <View
        style={{
          paddingHorizontal: 16,
          paddingVertical: 10,
          borderTopWidth: 1,
          borderTopColor: tokens.lineSoft,
        }}
      >
        <Text kind="micro" className="text-ink-3">
          Currently using: {currentEngineLabel}
        </Text>
      </View>
    </ListGroup>
  );
}

// ---------------------------------------------------------------------------
// Mode segmented control options
// ---------------------------------------------------------------------------

const MODE_OPTIONS = [
  { value: "ptt", label: "Hold to talk" },
  { value: "toggle", label: "Tap to toggle" },
] as const;

// ---------------------------------------------------------------------------
// Quality tier indicator
// ---------------------------------------------------------------------------

function QualityDots({ tier }: { tier: 1 | 2 | 3 }) {
  const tokens = useThemeTokens();
  return (
    <Row gap={3}>
      {([1, 2, 3] as const).map((i) => (
        <View
          key={i}
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: i <= tier ? tokens.accent : tokens.lineSoft,
          }}
        />
      ))}
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

type BadgeVariant = "ready" | "downloading" | "absent" | "failed";

function StatusBadge({
  variant,
  progress,
}: {
  variant: BadgeVariant;
  progress?: number;
}) {
  const tokens = useThemeTokens();

  const config: Record<BadgeVariant, { label: string; color: string }> = {
    ready: { label: "Ready", color: tokens.positive },
    downloading: {
      label: progress !== undefined ? `${Math.round(progress * 100)}%` : "Downloading…",
      color: tokens.warning,
    },
    absent: { label: "Not downloaded", color: tokens.ink3 },
    failed: { label: "Failed", color: tokens.danger },
  };

  const { label, color } = config[variant];

  return (
    <View
      style={{
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 6,
        backgroundColor: `${color}22`,
        alignSelf: "flex-start",
      }}
    >
      <Text kind="micro" style={{ color, fontWeight: "600" }}>
        {label}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Active model card
// ---------------------------------------------------------------------------

function ActiveModelCard() {
  const tokens = useThemeTokens();
  const activeModel = useWhisperModelState((s) => s.activeModel);
  const status = useWhisperModelState((s) => s.status);
  const progress = useWhisperModelState((s) => s.progress);
  const errorMessage = useWhisperModelState((s) => s.errorMessage);

  const modelOption = CURATED_MODELS.find((m) => m.name === activeModel);
  const friendlyName = modelOption?.label ?? activeModel;
  const sizeLabel = modelOption?.sizeLabel;

  const handleDownload = useCallback(() => {
    void useWhisperModelState.getState().ensureReady();
  }, []);

  const handleRedownload = useCallback(() => {
    Alert.alert(
      "Re-download model?",
      "This will delete the current model files and download them again.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Re-download",
          style: "destructive",
          onPress: () => void useWhisperModelState.getState().forceRedownload(),
        },
      ],
    );
  }, []);

  const handleRemove = useCallback(() => {
    Alert.alert(
      "Remove model from device?",
      "The model will be deleted from local storage. You can download it again later.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => void useWhisperModelState.getState().removeFromDevice(),
        },
      ],
    );
  }, []);

  return (
    <View
      className="bg-surface border border-line"
      style={{ marginHorizontal: 16, padding: 16, borderRadius: 14, gap: 12 }}
    >
      {/* Header row */}
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text kind="label">{friendlyName}</Text>
          {sizeLabel ? (
            <Text kind="caption" className="text-ink-3">
              {sizeLabel}
              {status === "ready" ? " · on device" : ""}
            </Text>
          ) : null}
        </View>
        <StatusBadge variant={status} progress={progress} />
      </View>

      {/* Progress bar — only while downloading */}
      {status === "downloading" ? (
        <ProgressBar value={progress} />
      ) : null}

      {/* Error message */}
      {status === "failed" && errorMessage ? (
        <Text kind="caption" style={{ color: tokens.danger }}>
          {errorMessage}
        </Text>
      ) : null}

      {/* Action buttons */}
      <View style={{ gap: 8 }}>
        {(status === "absent" || status === "failed") ? (
          <Button kind="primary" leftIcon="download" onClick={handleDownload}>
            Download model
          </Button>
        ) : null}

        {status === "ready" ? (
          <>
            <Button kind="secondary" leftIcon="refresh" onClick={handleRedownload}>
              Re-download model
            </Button>
            <Button kind="secondary" leftIcon="trash" onClick={handleRemove}>
              Remove from device
            </Button>
          </>
        ) : null}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Model picker
// ---------------------------------------------------------------------------

function ModelPicker() {
  const tokens = useThemeTokens();
  const activeModel = useWhisperModelState((s) => s.activeModel);
  const setActiveModel = useWhisperModelState((s) => s.setActiveModel);

  const handleSelect = useCallback(
    (name: WhisperModelName) => {
      if (name !== activeModel) {
        setActiveModel(name);
      }
    },
    [activeModel, setActiveModel],
  );

  return (
    <ListGroup
      header="Model"
      footer="Downloaded once, used offline forever. Larger models are more accurate but require more storage and processing time."
    >
      {CURATED_MODELS.map((opt) => {
        const isActive = opt.name === activeModel;
        return (
          <Pressable
            key={opt.name}
            onPress={() => handleSelect(opt.name)}
            accessibilityRole="radio"
            accessibilityState={{ selected: isActive }}
            style={{
              paddingVertical: 12,
              paddingHorizontal: 16,
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
            }}
          >
            {/* Radio indicator */}
            <View
              style={{
                width: 18,
                height: 18,
                borderRadius: 9,
                borderWidth: 2,
                borderColor: isActive ? tokens.accent : tokens.line,
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              {isActive ? (
                <View
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    backgroundColor: tokens.accent,
                  }}
                />
              ) : null}
            </View>

            {/* Label block */}
            <View style={{ flex: 1, gap: 2 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <Text
                  kind="body-lg"
                  style={{ fontWeight: isActive ? "600" : "400" }}
                >
                  {opt.label}
                </Text>
                {opt.isDefault ? (
                  <Text kind="micro" className="text-ink-3">
                    default
                  </Text>
                ) : null}
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text kind="caption" className="text-ink-3">
                  {opt.sizeLabel}
                </Text>
                {opt.note ? (
                  <Text kind="caption" style={{ color: tokens.warning }}>
                    {opt.note}
                  </Text>
                ) : null}
              </View>
            </View>

            {/* Quality tier dots */}
            <QualityDots tier={opt.qualityTier} />
          </Pressable>
        );
      })}
    </ListGroup>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function VoiceSettingsScreen() {
  const router = useRouter();
  const tokens = useThemeTokens();

  const enabled = useVoiceSettings((s) => s.enabled);
  const mode = useVoiceSettings((s) => s.mode);
  const language = useVoiceSettings((s) => s.language);
  const setEnabled = useVoiceSettings((s) => s.setEnabled);
  const setMode = useVoiceSettings((s) => s.setMode);
  const setLanguage = useVoiceSettings((s) => s.setLanguage);

  // Language picker state.
  const [localeOptions, setLocaleOptions] = useState<
    ReadonlyArray<LocaleOption>
  >([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    void fetchSupportedLocales().then((locales) => {
      setLocaleOptions(buildLocaleOptions(locales));
    });
  }, []);

  const onModeChange = useCallback(
    (next: string) => {
      if (next === "ptt" || next === "toggle") {
        setMode(next);
      }
    },
    [setMode],
  );

  const onSelectLocale = useCallback(
    (value: string | null) => {
      setLanguage(value);
      setPickerOpen(false);
    },
    [setLanguage],
  );

  const languageLabel = useMemo(() => {
    if (language === null) return `Device default (${DEVICE_LOCALE})`;
    return language;
  }, [language]);

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
              <Text kind="label">On-device transcription</Text>
              <Text kind="caption" className="text-ink-3">
                Voice input uses WhisperKit for on-device transcription. Audio
                is processed entirely on your device and never sent to a server.
              </Text>
            </Stack>
          </View>

          {/* ── Active model ───────────────────────────────────────── */}
          <Stack gap={8}>
            <Text
              kind="micro"
              className="text-ink-3 uppercase"
              style={{ paddingHorizontal: 16 }}
            >
              Active model
            </Text>
            <ActiveModelCard />
          </Stack>

          {/* ── Model picker ───────────────────────────────────────── */}
          <ModelPicker />

          {/* ── Speech recognition engine ──────────────────────────── */}
          <EnginePicker />

          {/* ── General ────────────────────────────────────────────── */}
          <ListGroup header="General">
            <ListRow
              icon="mic"
              title="Voice input"
              subtitle="Show the microphone button in the chat composer"
              right={<Toggle on={enabled} onChange={setEnabled} />}
            />
          </ListGroup>

          {/* ── Interaction mode ───────────────────────────────────── */}
          <ListGroup
            header="Interaction mode"
            footer="Hold to talk: press and hold the mic button. Tap to toggle: tap once to start, tap again to stop."
          >
            <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
              <SegControl
                options={MODE_OPTIONS as unknown as ReadonlyArray<{ value: string; label: string }>}
                value={mode}
                onChange={onModeChange}
              />
            </View>
          </ListGroup>

          {/* ── Language ───────────────────────────────────────────── */}
          <ListGroup
            header="Language"
            footer="Override the speech recognition language. Device default uses your system locale."
          >
            <ListRow
              icon="globe"
              title="Recognition language"
              detail={languageLabel}
              chevron
              onPress={() => setPickerOpen((prev) => !prev)}
            />
            {pickerOpen ? (
              <View
                style={{
                  paddingHorizontal: 16,
                  paddingBottom: 8,
                  maxHeight: 280,
                  overflow: "hidden",
                }}
              >
                <ScrollView
                  style={{ maxHeight: 260 }}
                  nestedScrollEnabled
                  showsVerticalScrollIndicator
                >
                  {localeOptions.map((opt) => {
                    const isActive =
                      opt.value === null
                        ? language === null
                        : language === opt.value;
                    return (
                      <Pressable
                        key={opt.value ?? "__device_default__"}
                        onPress={() => onSelectLocale(opt.value)}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: isActive }}
                        style={{
                          paddingVertical: 10,
                          paddingHorizontal: 4,
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 10,
                          borderBottomWidth: 1,
                          borderBottomColor: tokens.line,
                        }}
                      >
                        <View
                          style={{
                            width: 16,
                            height: 16,
                            borderRadius: 8,
                            borderWidth: 2,
                            borderColor: isActive ? tokens.accent : tokens.line,
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          {isActive ? (
                            <View
                              style={{
                                width: 7,
                                height: 7,
                                borderRadius: 3.5,
                                backgroundColor: tokens.accent,
                              }}
                            />
                          ) : null}
                        </View>
                        <Text
                          kind="body"
                          style={{
                            fontWeight: isActive ? "600" : "400",
                            flex: 1,
                          }}
                        >
                          {opt.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </View>
            ) : null}
          </ListGroup>

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
