/**
 * Voice settings screen — `(app)/(settings)/voice`.
 *
 * Surfaces the four voice input preferences:
 *   1. Enabled toggle
 *   2. Interaction mode (PTT / Tap-to-toggle) via SegControl
 *   3. Language picker (device default or an explicit BCP-47 locale)
 *   4. Auto-punctuation toggle
 *
 * Plus a "Manage in iOS Settings" link for permission management.
 *
 * Layout mirrors notifications.tsx: NavBar + ScrollView + ListGroup sections.
 * All state flows through useVoiceSettings (Zustand + AsyncStorage).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";

import {
  Button,
  ListGroup,
  ListRow,
  NavBar,
  PhoneSafeArea,
  Row,
  SegControl,
  Stack,
  Text,
  Toggle,
  useThemeTokens,
} from "@/components/ui";
import { useVoiceSettings } from "@/state/voice-settings";
import { openVoiceSettings } from "@/voice";

// ---------------------------------------------------------------------------
// Constants
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

/** Device locale resolved once at module level (same approach as useVoiceInput). */
function resolveDeviceLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale ?? "en-US";
  } catch {
    return "en-US";
  }
}

const DEVICE_LOCALE = resolveDeviceLocale();

// ---------------------------------------------------------------------------
// Language picker helpers
// ---------------------------------------------------------------------------

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

  // Deduplicate and sort, always pinning the device locale near the top.
  const set = new Set(supportedLocales);
  // Ensure device locale is present even if not returned by the API.
  set.add(DEVICE_LOCALE);
  const sorted = Array.from(set).sort((a, b) => a.localeCompare(b));

  return [
    deviceDefault,
    ...sorted.map((loc) => ({ value: loc, label: loc })),
  ];
}

// ---------------------------------------------------------------------------
// Mode segmented control options
// ---------------------------------------------------------------------------

const MODE_OPTIONS = [
  { value: "ptt", label: "Hold to talk" },
  { value: "toggle", label: "Tap to toggle" },
] as const;

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function VoiceSettingsScreen() {
  const router = useRouter();
  const tokens = useThemeTokens();

  const enabled = useVoiceSettings((s) => s.enabled);
  const mode = useVoiceSettings((s) => s.mode);
  const language = useVoiceSettings((s) => s.language);
  const addsPunctuation = useVoiceSettings((s) => s.addsPunctuation);
  const setEnabled = useVoiceSettings((s) => s.setEnabled);
  const setMode = useVoiceSettings((s) => s.setMode);
  const setLanguage = useVoiceSettings((s) => s.setLanguage);
  const setAddsPunctuation = useVoiceSettings((s) => s.setAddsPunctuation);

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
                Voice input transcribes your speech on-device using Apple's
                Speech Recognition. Audio stays on your device and is never
                sent to a server.
              </Text>
            </Stack>
          </View>

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

          {/* ── Transcription ──────────────────────────────────────── */}
          <ListGroup
            header="Transcription"
            footer="Auto-punctuation adds commas and full stops automatically via Apple's on-device model."
          >
            <ListRow
              icon="doc"
              title="Auto-punctuation"
              subtitle="Insert commas and full stops automatically"
              right={
                <Toggle on={addsPunctuation} onChange={setAddsPunctuation} />
              }
            />
          </ListGroup>

          {/* ── Permissions ────────────────────────────────────────── */}
          <ListGroup
            header="Permissions"
            footer="Manage microphone and speech recognition access for Hermes in iOS Settings."
          >
            <ListRow
              icon="shieldCheck"
              title="Manage in iOS Settings"
              subtitle="Change microphone or speech recognition permissions"
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
