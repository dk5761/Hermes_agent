/**
 * ThemeProvider — Hermes
 *
 * Owns runtime theme state for Uniwind:
 *   - `variant` (paper | graphite | plot)
 *   - `mode` (light | dark | system)
 *   - `density` (compact | comfortable) — read by components, not Uniwind
 *   - `fontOverride` — optional variant whose font stack to use, lets the
 *      user mix e.g. Graphite colors with Newsreader display. Stored only;
 *      Stage 1 doesn't apply it (font-family lives inside @variant blocks
 *      in global.css). Reserved for Stage 2 onward.
 *
 * On mount and on every change calls `Uniwind.setTheme(`${variant}-${resolvedMode}`)`.
 * Persists changes to AsyncStorage. Renders nothing until the persisted
 * state has been read once (hydration gate).
 *
 * Stage 9 additions:
 *   - "system" mode: when picked we resolve via useColorScheme() and update
 *     live whenever the OS toggles dark mode. The internal Uniwind theme
 *     name always uses the resolved (light | dark) value.
 *   - Cross-fade transition: every theme switch dims the screen briefly
 *     (220ms total: 1 → 0.7 → 1) so the palette swap is not jarring.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { View, useColorScheme } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { sqliteKv } from "@/state/sqlite-kv";
import { Uniwind, type ThemeName } from "uniwind";

export type Variant = "paper" | "graphite" | "plot";
export type Mode = "light" | "dark" | "system";
/** Mode actually used to drive Uniwind — system collapses to light or dark. */
export type ResolvedMode = "light" | "dark";

const VARIANTS: ReadonlyArray<Variant> = ["paper", "graphite", "plot"];
const MODES: ReadonlyArray<Mode> = ["light", "dark", "system"];
const DENSITIES: ReadonlyArray<Density> = ["compact", "comfortable"];

export type Density = "compact" | "comfortable";

const STORAGE_VARIANT = "theme.variant";
const STORAGE_MODE = "theme.mode";
const STORAGE_DENSITY = "theme.density";
const STORAGE_FONT_OVERRIDE = "theme.fontOverride";

const DEFAULT_VARIANT: Variant = "graphite";
const DEFAULT_MODE: Mode = "system";
const DEFAULT_DENSITY: Density = "comfortable";

// Motion preset from handoff: cubic-bezier(0.2, 0, 0, 1).
const FADE_EASING = Easing.bezier(0.2, 0, 0, 1);
const FADE_HALF_DURATION = 110; // ms; total round-trip = 220ms.
const FADE_DIM_OPACITY = 0.7;

export interface ThemeContextValue {
  variant: Variant;
  mode: Mode;
  /** Always light or dark — derived from `mode` + OS scheme when mode = "system". */
  resolvedMode: ResolvedMode;
  density: Density;
  fontOverride: Variant | null;
  themeName: string; // `${variant}-${resolvedMode}`
  setVariant: (v: Variant) => void;
  setMode: (m: Mode) => void;
  setDensity: (d: Density) => void;
  setFontOverride: (v: Variant | null) => void;
  toggleMode: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const isVariant = (v: unknown): v is Variant =>
  typeof v === "string" && (VARIANTS as ReadonlyArray<string>).includes(v);
const isMode = (v: unknown): v is Mode =>
  typeof v === "string" && (MODES as ReadonlyArray<string>).includes(v);
const isDensity = (v: unknown): v is Density =>
  typeof v === "string" && (DENSITIES as ReadonlyArray<string>).includes(v);

interface ThemeProviderProps {
  children: React.ReactNode;
  /** Optional initial overrides — superseded by AsyncStorage on hydrate. */
  initialVariant?: Variant;
  initialMode?: Mode;
  initialDensity?: Density;
}

export function ThemeProvider({
  children,
  initialVariant = DEFAULT_VARIANT,
  initialMode = DEFAULT_MODE,
  initialDensity = DEFAULT_DENSITY,
}: ThemeProviderProps) {
  const [hydrated, setHydrated] = useState(false);
  const [variant, setVariantState] = useState<Variant>(initialVariant);
  const [mode, setModeState] = useState<Mode>(initialMode);
  const [density, setDensityState] = useState<Density>(initialDensity);
  const [fontOverride, setFontOverrideState] = useState<Variant | null>(null);
  // useColorScheme re-renders whenever the OS appearance flips.
  const osScheme = useColorScheme();

  // Hydrate persisted state once on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [v, m, d, f] = await Promise.all([
          sqliteKv.getItem(STORAGE_VARIANT),
          sqliteKv.getItem(STORAGE_MODE),
          sqliteKv.getItem(STORAGE_DENSITY),
          sqliteKv.getItem(STORAGE_FONT_OVERRIDE),
        ]);
        if (cancelled) return;
        if (isVariant(v)) setVariantState(v);
        if (isMode(m)) setModeState(m);
        if (isDensity(d)) setDensityState(d);
        if (isVariant(f)) setFontOverrideState(f);
      } catch {
        // Ignore — fall back to defaults.
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Resolve "system" -> current OS scheme. Defaults to light when OS is null
  // (some platforms / older RN versions return null instead of a scheme).
  const resolvedMode: ResolvedMode = useMemo(() => {
    if (mode === "system") return osScheme === "dark" ? "dark" : "light";
    return mode;
  }, [mode, osScheme]);

  // Push the active theme name to Uniwind whenever it changes. The cast is
  // safe: every `${variant}-${resolvedMode}` combination is registered under
  // `extraThemes` in metro.config.js (mirrored in `uniwind-types.d.ts`).
  const themeName = `${variant}-${resolvedMode}` as ThemeName;

  // Cross-fade dim animation on every theme name change. Uses a single
  // Animated.View around `children` and runs opacity 1 → 0.7 → 1 so the
  // palette swap reads as a soft pulse rather than an instant flip.
  const opacity = useSharedValue(1);
  useEffect(() => {
    if (!hydrated) return;
    try {
      Uniwind.setTheme(themeName);
    } catch (err) {
      // Surface in dev — most likely cause is the theme not being listed
      // under `extraThemes` in metro.config.js.
      if (__DEV__) {
        console.warn(`[ThemeProvider] Uniwind.setTheme(${themeName}) failed`, err);
      }
    }
    opacity.value = withSequence(
      withTiming(FADE_DIM_OPACITY, {
        duration: FADE_HALF_DURATION,
        easing: FADE_EASING,
      }),
      withTiming(1, {
        duration: FADE_HALF_DURATION,
        easing: FADE_EASING,
      }),
    );
  }, [themeName, hydrated, opacity]);

  const fadeStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  const setVariant = useCallback((v: Variant) => {
    setVariantState(v);
    void sqliteKv.setItem(STORAGE_VARIANT, v);
  }, []);

  const setMode = useCallback((m: Mode) => {
    setModeState(m);
    void sqliteKv.setItem(STORAGE_MODE, m);
  }, []);

  const setDensity = useCallback((d: Density) => {
    setDensityState(d);
    void sqliteKv.setItem(STORAGE_DENSITY, d);
  }, []);

  const setFontOverride = useCallback((f: Variant | null) => {
    setFontOverrideState(f);
    if (f === null) {
      void sqliteKv.removeItem(STORAGE_FONT_OVERRIDE);
    } else {
      void sqliteKv.setItem(STORAGE_FONT_OVERRIDE, f);
    }
  }, []);

  const toggleMode = useCallback(() => {
    // Toggle only flips light <-> dark — leaves "system" untouched and
    // cycles to its opposite resolved value. We also persist.
    setModeState((prev) => {
      const next: Mode =
        prev === "light" ? "dark" : prev === "dark" ? "light" : "light";
      void sqliteKv.setItem(STORAGE_MODE, next);
      return next;
    });
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      variant,
      mode,
      resolvedMode,
      density,
      fontOverride,
      themeName,
      setVariant,
      setMode,
      setDensity,
      setFontOverride,
      toggleMode,
    }),
    [
      variant,
      mode,
      resolvedMode,
      density,
      fontOverride,
      themeName,
      setVariant,
      setMode,
      setDensity,
      setFontOverride,
      toggleMode,
    ],
  );

  // Hydration gate — render nothing until persisted state is loaded.
  // This avoids a flash of the default theme. Root layout's font-load
  // gate runs in parallel.
  if (!hydrated) {
    return null;
  }

  return (
    <ThemeContext.Provider value={value}>
      <Animated.View style={[{ flex: 1 }, fadeStyle]}>
        {/* Inner View just keeps Animated.View leaf-safe for any RN platform. */}
        <View style={{ flex: 1 }}>{children}</View>
      </Animated.View>
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within <ThemeProvider>");
  }
  return ctx;
}
