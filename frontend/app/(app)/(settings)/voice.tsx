/**
 * Voice settings screen — `(app)/(settings)/voice`.
 *
 * Sections:
 *   (A) Info card — transcription notice
 *   (B) Active model card — status badge, progress bar, action buttons
 *   (C) Model picker — curated WhisperKit variants with radio selection
 *   (D) Speech recognition engine — four-option engine radio + fallback toggle
 *                                   + addsPunctuation + current effective label
 *   (E) Recording limits — local cap slider + server cap slider
 *   (F) General — voice enabled toggle, language picker
 *   (G) Permissions — iOS Settings deep-link
 *
 * Layout mirrors notifications.tsx: NavBar + ScrollView + ListGroup sections.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";
import { Platform } from "react-native";
import Slider from "@react-native-community/slider";

import {
  Button,
  ListGroup,
  ListRow,
  NavBar,
  PhoneSafeArea,
  ProgressBar,
  Row,
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
import type { VoiceEngine } from "@/state/voice-settings";
import { useNetworkStatus } from "@/state/network-status";
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
    detail: "Hermes server when online, on-device WhisperKit when offline (or system if not downloaded).",
  },
  {
    value: "whisper",
    label: "WhisperKit (on-device)",
    detail: "Best privacy and quality. Requires model download.",
  },
  {
    value: "sfspeech",
    label: "Apple system (SFSpeech)",
    detail: "Instant. Uses system languages.",
  },
  {
    value: "server",
    label: "Hermes server",
    detail: "Long recordings, best for >60s. Requires connection.",
  },
] as const;

function EnginePicker() {
  const tokens = useThemeTokens();
  const engine = useVoiceSettings((s) => s.engine);
  const addsPunctuation = useVoiceSettings((s) => s.addsPunctuation);
  const fallbackOnOffline = useVoiceSettings((s) => s.fallbackOnOffline);
  const setEngine = useVoiceSettings((s) => s.setEngine);
  const setAddsPunctuation = useVoiceSettings((s) => s.setAddsPunctuation);
  const setFallbackOnOffline = useVoiceSettings((s) => s.setFallbackOnOffline);
  const modelStatus = useWhisperModelState((s) => s.status);
  const online = useNetworkStatus((s) => s.online);

  // Derive which engine is actually active right now for the status label.
  const effectiveEngine = resolveEngine({ engine, modelStatus, online, fallbackOnOffline });

  const currentEngineLabel: string = (() => {
    switch (effectiveEngine) {
      case "whisper": return "WhisperKit (on-device)";
      case "sfspeech": return "Apple system (SFSpeech)";
      case "server": return "Hermes server";
      case "blocked": return "Offline — server unavailable";
    }
  })();

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
      footer="Auto picks Hermes server when you're online (best quality, multilingual). Falls back to WhisperKit on-device when offline, or Apple's system recognizer if WhisperKit isn't downloaded."
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

      {/* Fallback toggle — always visible; controls behaviour when server engine is offline */}
      <ListRow
        icon="globe"
        title="Use on-device when offline"
        subtitle="If on, switches to WhisperKit or Apple Speech when offline and Hermes server is selected. If off, mic is disabled offline."
        right={
          <Toggle on={fallbackOnOffline} onChange={setFallbackOnOffline} />
        }
      />

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
  const language = useVoiceSettings((s) => s.language);
  const setEnabled = useVoiceSettings((s) => s.setEnabled);
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
              <Text kind="label">Voice transcription</Text>
              <Text kind="caption" className="text-ink-3">
                On-device engines (WhisperKit, Apple) process audio entirely on
                your device. The Hermes server engine uploads audio to your
                self-hosted server for longer recordings.
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
