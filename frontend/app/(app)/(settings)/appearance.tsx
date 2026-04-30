/**
 * Appearance — variant cards + mode SegControl + density SegControl.
 *
 * Per UI_REBUILD_PLAN §6 / handoff §3.3. Persistence is already wired
 * through ThemeProvider's AsyncStorage hooks; we just call the setters.
 *
 * "System" mode is partially supported: when picked, we resolve the OS
 * color scheme via useColorScheme() and call setMode with that scalar.
 * True OS-driven follow-along (mode auto-flipping when the OS toggles
 * dark mode) is deferred — see report §"punted".
 */
import { useCallback, useMemo } from "react";
import { Pressable, ScrollView, View, useColorScheme } from "react-native";
import { useRouter } from "expo-router";

import {
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
import { useTheme, type Variant, type Mode, type Density } from "@/theme";

interface VariantCardSpec {
  id: Variant;
  label: string;
  swatches: { bg: string; surface: string; ink: string; accent: string };
}

// Use the *light* palette swatches as the visual identity per card so the
// chooser is legible even in dark mode.
const VARIANT_CARDS: ReadonlyArray<VariantCardSpec> = [
  {
    id: "graphite",
    label: "Graphite",
    swatches: { bg: "#F7F8FA", surface: "#FFFFFF", ink: "#0E1116", accent: "#4F46E5" },
  },
  {
    id: "paper",
    label: "Paper",
    swatches: { bg: "#FAF8F4", surface: "#FFFFFF", ink: "#1C1A17", accent: "#B85C2E" },
  },
  {
    id: "plot",
    label: "Plot",
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
}

function VariantCard({
  spec,
  active,
  onPick,
  accent,
  line,
  surface,
}: VariantCardProps) {
  const onPress = useCallback(() => onPick(spec.id), [onPick, spec.id]);
  return (
    <Pressable
      onPress={onPress}
      style={{
        flex: 1,
        padding: 12,
        borderRadius: 14,
        borderWidth: active ? 2 : 1,
        borderColor: active ? accent : line,
        backgroundColor: surface,
        gap: 10,
      }}
    >
      {/* 4 swatches in a 2x2 grid */}
      <View style={{ flexDirection: "row", gap: 6 }}>
        <View style={{ flex: 1, gap: 6 }}>
          <View
            style={{
              height: 18,
              borderRadius: 4,
              backgroundColor: spec.swatches.bg,
              borderWidth: 1,
              borderColor: line,
            }}
          />
          <View
            style={{
              height: 18,
              borderRadius: 4,
              backgroundColor: spec.swatches.ink,
            }}
          />
        </View>
        <View style={{ flex: 1, gap: 6 }}>
          <View
            style={{
              height: 18,
              borderRadius: 4,
              backgroundColor: spec.swatches.surface,
              borderWidth: 1,
              borderColor: line,
            }}
          />
          <View
            style={{
              height: 18,
              borderRadius: 4,
              backgroundColor: spec.swatches.accent,
            }}
          />
        </View>
      </View>
      <Text kind="label" style={{ fontWeight: active ? "600" : "500" }}>
        {spec.label}
      </Text>
    </Pressable>
  );
}

type ModeSeg = "light" | "dark" | "system";

export default function AppearanceScreen() {
  const router = useRouter();
  const { variant, mode, density, setVariant, setMode, setDensity } = useTheme();
  const tokens = useThemeTokens();
  const osScheme = useColorScheme();

  // We don't persist a "system" mode — when the user picks system we resolve
  // to the OS scheme right now and store that. Live OS-tracking is deferred.
  const modeSegValue: ModeSeg = mode;

  const onPickVariant = useCallback(
    (v: Variant) => setVariant(v),
    [setVariant],
  );

  const onChangeMode = useCallback(
    (next: string) => {
      if (next === "system") {
        const resolved: Mode = osScheme === "dark" ? "dark" : "light";
        setMode(resolved);
      } else if (next === "light" || next === "dark") {
        setMode(next);
      }
    },
    [osScheme, setMode],
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

  return (
    <PhoneSafeArea>
      <NavBar title="Appearance" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 60 }}>
        <Stack gap={20} style={{ paddingTop: 8 }}>
          <Section title="Variant">
            <Row gap={10} style={{ paddingHorizontal: 16 }}>
              {VARIANT_CARDS.map((spec) => (
                <VariantCard
                  key={spec.id}
                  spec={spec}
                  active={variant === spec.id}
                  onPick={onPickVariant}
                  accent={tokens.accent}
                  line={tokens.line}
                  surface={tokens.surface}
                />
              ))}
            </Row>
          </Section>

          <Section title="Mode">
            <View style={{ paddingHorizontal: 16 }}>
              <SegControl
                options={modeOptions}
                value={modeSegValue}
                onChange={onChangeMode}
              />
            </View>
          </Section>

          <Section title="Density">
            <View style={{ paddingHorizontal: 16 }}>
              <SegControl
                options={densityOptions}
                value={density}
                onChange={onChangeDensity}
              />
            </View>
          </Section>

          <ListGroup
            header="Preview"
            footer="Density affects list-row heights and section spacing throughout the app."
          >
            <ListRow icon="spark" title="Sample row" subtitle="Subtitle text" detail="value" chevron />
            <ListRow icon="bolt" title="Another row" detail="value" chevron />
          </ListGroup>
        </Stack>
      </ScrollView>
    </PhoneSafeArea>
  );
}
