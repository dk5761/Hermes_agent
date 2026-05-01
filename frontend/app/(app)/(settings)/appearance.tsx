/**
 * Appearance — Stage 9 redesign.
 *
 * Per UI_REBUILD_PLAN §6 / handoff §3.3. Persistence is wired through
 * ThemeProvider's AsyncStorage hooks; we just call the setters.
 *
 * Sections:
 *   1. Variant — three large cards in a wrap-row. Each card shows a 2x2
 *      swatch grid (bg, surface, ink, accent) + label + descriptor. Active
 *      card has a 2px accent border + checkmark badge top-right.
 *   2. Mode — SegControl Light/Dark/System. When System is chosen we show
 *      a caption confirming what the OS currently resolves to.
 *   3. Density — SegControl Compact/Comfortable + a sample ListRow preview.
 *   4. Font override — collapsible advanced section. Stage 9 leaves the
 *      *application* of the override as TODO; the picker is wired but the
 *      visual effect is per-palette `@variant` font CSS in global.css and
 *      changing it dynamically is out of scope for this stage.
 */
import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";

import {
  Icon,
  ListGroup,
  ListRow,
  NavBar,
  PhoneSafeArea,
  Row,
  SegControl,
  Section,
  Stack,
  Text,
  useThemeTokens,
} from "@/components/ui";
import {
  useTheme,
  type Density,
  type Mode,
  type Variant,
} from "@/theme";

interface VariantCardSpec {
  id: Variant;
  label: string;
  descriptor: string;
  swatches: { bg: string; surface: string; ink: string; accent: string };
}

// Use the *light* palette swatches as the visual identity per card so the
// chooser is legible in both modes. These mirror tokens.ts verbatim.
const VARIANT_CARDS: ReadonlyArray<VariantCardSpec> = [
  {
    id: "paper",
    label: "Paper",
    descriptor: "warm",
    swatches: { bg: "#FAF8F4", surface: "#FFFFFF", ink: "#1C1A17", accent: "#B85C2E" },
  },
  {
    id: "graphite",
    label: "Graphite",
    descriptor: "cool neutrals",
    swatches: { bg: "#F7F8FA", surface: "#FFFFFF", ink: "#0E1116", accent: "#4F46E5" },
  },
  {
    id: "plot",
    label: "Plot",
    descriptor: "editorial",
    swatches: { bg: "#F4F1EA", surface: "#FFFDF7", ink: "#15140F", accent: "#6B2E48" },
  },
];

interface VariantCardProps {
  spec: VariantCardSpec;
  active: boolean;
  onPick: (id: Variant) => void;
  accent: string;
  line: string;
  surface: string;
  ink2: string;
}

function VariantCard({
  spec,
  active,
  onPick,
  accent,
  line,
  surface,
  ink2,
}: VariantCardProps) {
  const onPress = useCallback(() => onPick(spec.id), [onPick, spec.id]);
  // Card sized to fit roughly 3-up at 390pt screen width but flex-wraps on
  // narrow devices. Min width 100 enforces wrap before things get too tight.
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`${spec.label} variant`}
      style={{
        flexBasis: 0,
        flexGrow: 1,
        minWidth: 100,
        height: 140,
        padding: 12,
        borderRadius: 14,
        borderWidth: active ? 2 : 1,
        borderColor: active ? accent : line,
        backgroundColor: surface,
        gap: 8,
        position: "relative",
      }}
    >
      {/* 2x2 swatch grid: bg + ink (left col), surface + accent (right col). */}
      <View style={{ flexDirection: "row", gap: 6, height: 56 }}>
        <View style={{ flex: 1, gap: 6 }}>
          <View
            style={{
              flex: 1,
              borderRadius: 4,
              backgroundColor: spec.swatches.bg,
              borderWidth: 1,
              borderColor: line,
            }}
          />
          <View
            style={{
              flex: 1,
              borderRadius: 4,
              backgroundColor: spec.swatches.ink,
            }}
          />
        </View>
        <View style={{ flex: 1, gap: 6 }}>
          <View
            style={{
              flex: 1,
              borderRadius: 4,
              backgroundColor: spec.swatches.surface,
              borderWidth: 1,
              borderColor: line,
            }}
          />
          <View
            style={{
              flex: 1,
              borderRadius: 4,
              backgroundColor: spec.swatches.accent,
            }}
          />
        </View>
      </View>
      <View style={{ gap: 2 }}>
        <Text kind="label" style={{ fontWeight: active ? "600" : "500" }}>
          {spec.label}
        </Text>
        <Text kind="caption" style={{ color: ink2 }}>
          {spec.descriptor}
        </Text>
      </View>
      {/* Checkmark badge top-right when active. */}
      {active ? (
        <View
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            width: 20,
            height: 20,
            borderRadius: 10,
            backgroundColor: accent,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="check" size={12} color="#FFFFFF" />
        </View>
      ) : null}
    </Pressable>
  );
}

type FontOverrideOption = "match" | "paper" | "graphite" | "plot";

const FONT_OVERRIDE_OPTIONS: ReadonlyArray<{
  value: FontOverrideOption;
  label: string;
  hint: string;
}> = [
  { value: "match", label: "Match active variant", hint: "Default — display font follows the variant." },
  { value: "paper", label: "Paper · JetBrains Mono", hint: "Monospaced, iA Writer feel." },
  { value: "graphite", label: "Graphite · Inter Tight", hint: "Crisp, neutral sans-serif." },
  { value: "plot", label: "Plot · Newsreader", hint: "Editorial serif." },
];

export default function AppearanceScreen() {
  const router = useRouter();
  const {
    variant,
    mode,
    density,
    resolvedMode,
    fontOverride,
    setVariant,
    setMode,
    setDensity,
    setFontOverride,
  } = useTheme();
  const tokens = useThemeTokens();

  const onPickVariant = useCallback(
    (v: Variant) => setVariant(v),
    [setVariant],
  );

  const onChangeMode = useCallback(
    (next: string) => {
      if (next === "light" || next === "dark" || next === "system") {
        setMode(next as Mode);
      }
    },
    [setMode],
  );

  const onChangeDensity = useCallback(
    (next: string) => {
      if (next === "compact" || next === "comfortable") {
        setDensity(next as Density);
      }
    },
    [setDensity],
  );

  const modeOptions = useMemo(
    () => [
      { value: "light", label: "Light" },
      { value: "dark", label: "Dark" },
      { value: "system", label: "System" },
    ],
    [],
  );

  const densityOptions = useMemo(
    () => [
      { value: "compact", label: "Compact" },
      { value: "comfortable", label: "Comfortable" },
    ],
    [],
  );

  // Map persisted Variant | null -> FontOverrideOption for the selector UI.
  const fontOverrideValue: FontOverrideOption = fontOverride ?? "match";
  const onPickFontOverride = useCallback(
    (next: FontOverrideOption) => {
      setFontOverride(next === "match" ? null : (next satisfies Variant));
    },
    [setFontOverride],
  );

  // Advanced font override is collapsed by default to keep the screen clean.
  const [fontExpanded, setFontExpanded] = useState(false);

  return (
    <PhoneSafeArea>
      <NavBar title="Appearance" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 60 }}>
        <Stack gap={20} style={{ paddingTop: 8 }}>
          {/* ── Variant ─────────────────────────────────────────── */}
          <Section title="Variant">
            <View style={{ paddingHorizontal: 16, flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
              {VARIANT_CARDS.map((spec) => (
                <VariantCard
                  key={spec.id}
                  spec={spec}
                  active={variant === spec.id}
                  onPick={onPickVariant}
                  accent={tokens.accent}
                  line={tokens.line}
                  surface={tokens.surface}
                  ink2={tokens.ink2}
                />
              ))}
            </View>
          </Section>

          {/* ── Mode ────────────────────────────────────────────── */}
          <Section title="Mode">
            <View style={{ paddingHorizontal: 16, gap: 8 }}>
              <SegControl
                options={modeOptions}
                value={mode}
                onChange={onChangeMode}
              />
              {mode === "system" ? (
                <Text kind="caption" style={{ color: tokens.ink3 }}>
                  System resolves to {resolvedMode} right now.
                </Text>
              ) : null}
            </View>
          </Section>

          {/* ── Density ─────────────────────────────────────────── */}
          <Section title="Density">
            <View style={{ paddingHorizontal: 16, gap: 12 }}>
              <SegControl
                options={densityOptions}
                value={density}
                onChange={onChangeDensity}
              />
              {/* Live preview row inside a card so density change is visible. */}
              <View
                style={{
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: tokens.line,
                  backgroundColor: tokens.surface,
                  overflow: "hidden",
                }}
              >
                <ListRow
                  icon="spark"
                  title="Sample row"
                  subtitle="Subtitle text"
                  detail="value"
                  chevron
                />
              </View>
            </View>
          </Section>

          {/* ── Advanced: font override ────────────────────────── */}
          <Section title="Advanced">
            <View style={{ paddingHorizontal: 16, gap: 8 }}>
              <Pressable
                onPress={() => setFontExpanded((prev) => !prev)}
                accessibilityRole="button"
                accessibilityLabel="Toggle font override section"
                style={{
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: tokens.line,
                  backgroundColor: tokens.surface,
                  paddingVertical: 12,
                  paddingHorizontal: 14,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  <Text kind="body-lg">Display font</Text>
                  <Text kind="caption" style={{ color: tokens.ink3 }}>
                    {fontOverrideValue === "match"
                      ? "Match active variant"
                      : FONT_OVERRIDE_OPTIONS.find((o) => o.value === fontOverrideValue)?.label}
                  </Text>
                </View>
                <Icon
                  name={fontExpanded ? "chevU" : "chevD"}
                  size={16}
                  color={tokens.ink3}
                />
              </Pressable>

              {fontExpanded ? (
                <View style={{ gap: 8 }}>
                  {FONT_OVERRIDE_OPTIONS.map((opt) => {
                    const active = opt.value === fontOverrideValue;
                    return (
                      <Pressable
                        key={opt.value}
                        onPress={() => onPickFontOverride(opt.value)}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: active }}
                        style={{
                          borderRadius: 10,
                          borderWidth: active ? 2 : 1,
                          borderColor: active ? tokens.accent : tokens.line,
                          backgroundColor: tokens.surface,
                          paddingVertical: 10,
                          paddingHorizontal: 14,
                          gap: 2,
                        }}
                      >
                        <Row align="center" gap={8}>
                          <View
                            style={{
                              width: 14,
                              height: 14,
                              borderRadius: 7,
                              borderWidth: 2,
                              borderColor: active ? tokens.accent : tokens.line,
                              alignItems: "center",
                              justifyContent: "center",
                            }}
                          >
                            {active ? (
                              <View
                                style={{
                                  width: 6,
                                  height: 6,
                                  borderRadius: 3,
                                  backgroundColor: tokens.accent,
                                }}
                              />
                            ) : null}
                          </View>
                          <Text
                            kind="body"
                            style={{ fontWeight: active ? "600" : "500" }}
                          >
                            {opt.label}
                          </Text>
                        </Row>
                        <Text kind="caption" style={{ color: tokens.ink3, paddingLeft: 22 }}>
                          {opt.hint}
                        </Text>
                      </Pressable>
                    );
                  })}
                  <Text kind="caption" style={{ color: tokens.ink3, paddingTop: 4 }}>
                    Coming soon — picking a different display font without
                    changing the colour palette is wired through state but the
                    runtime swap requires per-variant CSS that ships in a
                    later phase.
                  </Text>
                </View>
              ) : null}
            </View>
          </Section>

          {/* ── Helper card ────────────────────────────────────── */}
          <ListGroup
            header="About appearance"
            footer="Variant, mode, and density persist locally on this device."
          >
            <ListRow
              icon="cog"
              title="Active theme"
              detail={`${variant} · ${resolvedMode}`}
            />
          </ListGroup>
        </Stack>
      </ScrollView>
    </PhoneSafeArea>
  );
}
