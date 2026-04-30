/**
 * /__theme — Stage 1 visual regression check (dev only).
 *
 * Renders all 14 color tokens, all 10 type-scale variants, all three font
 * stacks, and a button row that switches between every combination of
 * variant × mode. Used to verify Stage 1 wiring without touching real
 * screens. Will be deleted at Stage 6.
 *
 * Reachable from Settings -> "Theme debug" (a dev-only button added at
 * the bottom of `app/(app)/settings.tsx`) or by typing `/__theme` in the
 * Expo dev client URL bar.
 */
import React from "react";
import { Pressable, ScrollView, View, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, useRouter } from "expo-router";
import {
  useTheme,
  type Density,
  type Mode,
  type Variant,
} from "@/theme";

const COLOR_TOKENS = [
  "bg",
  "surface",
  "sunken",
  "line",
  "line-soft",
  "chip",
  "ink",
  "ink-2",
  "ink-3",
  "accent",
  "accent-bg",
  "positive",
  "warning",
  "danger",
] as const;

// Tailwind class for the swatch background, keyed by token.
// Written inline so Uniwind's compiler statically sees every class name.
const SWATCH_BG: Record<(typeof COLOR_TOKENS)[number], string> = {
  bg: "bg-bg",
  surface: "bg-surface",
  sunken: "bg-sunken",
  line: "bg-line",
  "line-soft": "bg-line-soft",
  chip: "bg-chip",
  ink: "bg-ink",
  "ink-2": "bg-ink-2",
  "ink-3": "bg-ink-3",
  accent: "bg-accent",
  "accent-bg": "bg-accent-bg",
  positive: "bg-positive",
  warning: "bg-warning",
  danger: "bg-danger",
};

const TYPE_KINDS = [
  "display",
  "h1",
  "h2",
  "h3",
  "body-lg",
  "body",
  "label",
  "caption",
  "micro",
  "mono",
] as const;

// Class for each kind. Listed inline so Uniwind statically discovers them.
const TYPE_CLASS: Record<(typeof TYPE_KINDS)[number], string> = {
  display: "text-display",
  h1: "text-h1",
  h2: "text-h2",
  h3: "text-h3",
  "body-lg": "text-body-lg",
  body: "text-body",
  label: "text-label",
  caption: "text-caption",
  micro: "text-micro",
  mono: "text-mono",
};

type Combo = { variant: Variant; mode: Mode; label: string };
const COMBOS: ReadonlyArray<Combo> = [
  { variant: "paper", mode: "light", label: "Paper · Light" },
  { variant: "paper", mode: "dark", label: "Paper · Dark" },
  { variant: "graphite", mode: "light", label: "Graphite · Light" },
  { variant: "graphite", mode: "dark", label: "Graphite · Dark" },
  { variant: "plot", mode: "light", label: "Plot · Light" },
  { variant: "plot", mode: "dark", label: "Plot · Dark" },
];

export default function ThemeDebugScreen() {
  const router = useRouter();
  const {
    variant,
    mode,
    density,
    setVariant,
    setMode,
    setDensity,
    themeName,
  } = useTheme();

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <SafeAreaView className="flex-1 bg-bg" edges={["top", "left", "right"]}>
        <ScrollView
          contentContainerClassName="px-4 pt-2 pb-12 gap-6"
          contentInsetAdjustmentBehavior="never"
        >
          {/* ── Header ────────────────────────────────────────── */}
          <View className="flex-row items-center justify-between">
            <View className="flex-1">
              <Text className="text-micro text-ink-3 uppercase">
                Stage 1 debug
              </Text>
              <Text className="text-h1 text-ink font-display">
                Theme tokens
              </Text>
              <Text className="text-body text-ink-2 font-body">
                Active: <Text className="text-mono">{themeName}</Text> ·
                density: <Text className="text-mono">{density}</Text>
              </Text>
            </View>
            <Pressable
              onPress={() => router.back()}
              className="px-3 py-2 rounded-md border border-line"
            >
              <Text className="text-label text-ink">Close</Text>
            </Pressable>
          </View>

          {/* ── Theme switcher ─────────────────────────────────── */}
          <Section title="Variant × mode">
            <View className="flex-row flex-wrap gap-2">
              {COMBOS.map((c) => {
                const active = c.variant === variant && c.mode === mode;
                return (
                  <Pressable
                    key={c.label}
                    onPress={() => {
                      setVariant(c.variant);
                      setMode(c.mode);
                    }}
                    className={
                      "px-3 py-2 rounded-md border " +
                      (active
                        ? "bg-ink border-ink"
                        : "bg-surface border-line")
                    }
                  >
                    <Text
                      className={
                        "text-label " +
                        (active ? "text-surface" : "text-ink")
                      }
                    >
                      {c.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </Section>

          {/* ── Density toggle ─────────────────────────────────── */}
          <Section title="Density">
            <View className="flex-row gap-2">
              {(["compact", "comfortable"] as const).map((d) => {
                const active = d === density;
                return (
                  <Pressable
                    key={d}
                    onPress={() => setDensity(d as Density)}
                    className={
                      "px-3 py-2 rounded-md border " +
                      (active
                        ? "bg-ink border-ink"
                        : "bg-surface border-line")
                    }
                  >
                    <Text
                      className={
                        "text-label " +
                        (active ? "text-surface" : "text-ink")
                      }
                    >
                      {d}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </Section>

          {/* ── Color swatches ─────────────────────────────────── */}
          <Section title="Color tokens">
            <View className="flex-row flex-wrap gap-3">
              {COLOR_TOKENS.map((token) => (
                <View key={token} className="w-[30%] gap-1">
                  <View
                    className={
                      "h-12 w-full rounded-md border border-line " +
                      SWATCH_BG[token]
                    }
                  />
                  <Text className="text-mono text-ink">{token}</Text>
                </View>
              ))}
            </View>
          </Section>

          {/* ── Type scale ─────────────────────────────────────── */}
          <Section title="Type scale">
            <View className="gap-3">
              {TYPE_KINDS.map((k) => (
                <View key={k} className="gap-1">
                  <Text className="text-micro text-ink-3 uppercase">{k}</Text>
                  <Text className={TYPE_CLASS[k] + " text-ink font-body"}>
                    The quick brown fox jumps over the lazy dog
                  </Text>
                </View>
              ))}
            </View>
          </Section>

          {/* ── Font stacks ────────────────────────────────────── */}
          <Section title="Font families (active variant)">
            <View className="gap-2">
              <View className="gap-0.5">
                <Text className="text-micro text-ink-3 uppercase">
                  font-display
                </Text>
                <Text className="text-h2 font-display text-ink">
                  Hermes — display
                </Text>
              </View>
              <View className="gap-0.5">
                <Text className="text-micro text-ink-3 uppercase">
                  font-body
                </Text>
                <Text className="text-body-lg font-body text-ink">
                  Hermes — body. The quick brown fox.
                </Text>
              </View>
              <View className="gap-0.5">
                <Text className="text-micro text-ink-3 uppercase">
                  font-mono
                </Text>
                <Text className="text-mono font-mono text-ink">
                  $ hermes run --once 0xCAFE
                </Text>
              </View>
            </View>
          </Section>
        </ScrollView>
      </SafeAreaView>
    </>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View className="gap-2">
      <Text className="text-micro text-ink-3 uppercase">{title}</Text>
      <View className="rounded-lg border border-line bg-surface p-3 gap-2">
        {children}
      </View>
    </View>
  );
}
