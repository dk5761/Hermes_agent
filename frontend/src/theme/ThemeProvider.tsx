/**
 * ThemeProvider — Hermes
 *
 * Owns runtime theme state for Uniwind:
 *   - `variant` (paper | graphite | plot)
 *   - `mode` (light | dark)
 *   - `density` (compact | comfortable) — read by components, not Uniwind
 *   - `fontOverride` — optional variant whose font stack to use, lets the
 *      user mix e.g. Graphite colors with Newsreader display. Stored only;
 *      Stage 1 doesn't apply it (font-family lives inside @variant blocks
 *      in global.css). Reserved for Stage 2 onward.
 *
 * On mount and on every change calls `Uniwind.setTheme(`${variant}-${mode}`)`.
 * Persists changes to AsyncStorage. Renders nothing until the persisted
 * state has been read once (hydration gate).
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Uniwind, type ThemeName } from "uniwind";

export type Variant = "paper" | "graphite" | "plot";
export type Mode = "light" | "dark";
export type Density = "compact" | "comfortable";

const VARIANTS: ReadonlyArray<Variant> = ["paper", "graphite", "plot"];
const MODES: ReadonlyArray<Mode> = ["light", "dark"];
const DENSITIES: ReadonlyArray<Density> = ["compact", "comfortable"];

const STORAGE_VARIANT = "theme.variant";
const STORAGE_MODE = "theme.mode";
const STORAGE_DENSITY = "theme.density";
const STORAGE_FONT_OVERRIDE = "theme.fontOverride";

const DEFAULT_VARIANT: Variant = "graphite";
const DEFAULT_MODE: Mode = "light";
const DEFAULT_DENSITY: Density = "comfortable";

export interface ThemeContextValue {
  variant: Variant;
  mode: Mode;
  density: Density;
  fontOverride: Variant | null;
  themeName: string; // `${variant}-${mode}`
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

  // Hydrate persisted state once on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [[, v], [, m], [, d], [, f]] = await AsyncStorage.multiGet([
          STORAGE_VARIANT,
          STORAGE_MODE,
          STORAGE_DENSITY,
          STORAGE_FONT_OVERRIDE,
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

  // Push the active theme name to Uniwind whenever it changes. The cast is
  // safe: every `${variant}-${mode}` combination is registered under
  // `extraThemes` in metro.config.js (mirrored in `uniwind-types.d.ts`).
  const themeName = `${variant}-${mode}` as ThemeName;
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
  }, [themeName, hydrated]);

  const setVariant = useCallback((v: Variant) => {
    setVariantState(v);
    void AsyncStorage.setItem(STORAGE_VARIANT, v);
  }, []);

  const setMode = useCallback((m: Mode) => {
    setModeState(m);
    void AsyncStorage.setItem(STORAGE_MODE, m);
  }, []);

  const setDensity = useCallback((d: Density) => {
    setDensityState(d);
    void AsyncStorage.setItem(STORAGE_DENSITY, d);
  }, []);

  const setFontOverride = useCallback((f: Variant | null) => {
    setFontOverrideState(f);
    if (f === null) {
      void AsyncStorage.removeItem(STORAGE_FONT_OVERRIDE);
    } else {
      void AsyncStorage.setItem(STORAGE_FONT_OVERRIDE, f);
    }
  }, []);

  const toggleMode = useCallback(() => {
    setModeState((prev) => {
      const next: Mode = prev === "light" ? "dark" : "light";
      void AsyncStorage.setItem(STORAGE_MODE, next);
      return next;
    });
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      variant,
      mode,
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

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within <ThemeProvider>");
  }
  return ctx;
}
