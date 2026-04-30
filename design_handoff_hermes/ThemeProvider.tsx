/**
 * Hermes — ThemeProvider for React Native + NativeWind
 *
 * Sets the active palette as CSS variables on a root <View> via NativeWind's
 * `vars()` helper, so all `bg-bg`, `text-ink`, `border-line` etc. utilities
 * resolve correctly. Tailwind config (tailwind.config.js) maps `var(--bg)` →
 * the `bg` color name; we just have to make sure the variables are set.
 *
 * Persist `variant`/`mode` to AsyncStorage in your real app.
 */
import React, { createContext, useContext, useState, useMemo } from 'react';
import { View } from 'react-native';
import { vars } from 'nativewind';
import { resolveTheme, Variant, Mode, Theme } from './theme';

interface ThemeCtx {
  theme: Theme;
  variant: Variant;
  mode: Mode;
  setVariant: (v: Variant) => void;
  setMode: (m: Mode) => void;
  toggleMode: () => void;
}

const Ctx = createContext<ThemeCtx | null>(null);

export function ThemeProvider({
  children,
  initialVariant = 'graphite',
  initialMode = 'light',
}: {
  children: React.ReactNode;
  initialVariant?: Variant;
  initialMode?: Mode;
}) {
  const [variant, setVariant] = useState<Variant>(initialVariant);
  const [mode, setMode] = useState<Mode>(initialMode);

  const theme = useMemo(() => resolveTheme(variant, mode), [variant, mode]);

  const cssVars = useMemo(() => vars({
    '--bg': theme.bg,
    '--surface': theme.surface,
    '--sunken': theme.sunken,
    '--line': theme.line,
    '--line-soft': theme['line-soft'],
    '--chip': theme.chip,
    '--ink': theme.ink,
    '--ink-2': theme['ink-2'],
    '--ink-3': theme['ink-3'],
    '--accent': theme.accent,
    '--accent-bg': theme['accent-bg'],
    '--positive': theme.positive,
    '--warning': theme.warning,
    '--danger': theme.danger,
    '--font-display': theme.fonts.display,
    '--font-body': theme.fonts.body,
    '--font-mono': theme.fonts.mono,
  }), [theme]);

  const ctx: ThemeCtx = {
    theme, variant, mode,
    setVariant, setMode,
    toggleMode: () => setMode(m => m === 'light' ? 'dark' : 'light'),
  };

  return (
    <Ctx.Provider value={ctx}>
      <View style={cssVars} className="flex-1 bg-bg">
        {children}
      </View>
    </Ctx.Provider>
  );
}

export function useTheme() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTheme must be used inside <ThemeProvider>');
  return v;
}
