/**
 * Hermes — runtime theme tokens
 *
 * Three variants × light/dark = 6 palettes. The ThemeProvider injects the
 * active palette as CSS variables (web) or via vars() (NativeWind v4 native),
 * so Tailwind utilities like `bg-bg text-ink border-line` always resolve.
 *
 * Pair this with tailwind.config.js. See README for usage.
 */

export type Variant = 'paper' | 'graphite' | 'plot';
export type Mode = 'light' | 'dark';

export interface Palette {
  bg: string;
  surface: string;
  sunken: string;
  line: string;
  'line-soft': string;
  chip: string;
  ink: string;
  'ink-2': string;
  'ink-3': string;
  accent: string;
  'accent-bg': string;
  positive: string;
  warning: string;
  danger: string;
}

export interface FontStack {
  display: string;
  body: string;
  mono: string;
}

// ─── Palettes ────────────────────────────────────────────────────
export const palettes: Record<Variant, Record<Mode, Palette>> = {
  paper: {
    light: {
      bg: '#FAF8F4', surface: '#FFFFFF', sunken: '#F2EEE6',
      line: '#E5DFD2', 'line-soft': '#EFEAE0', chip: '#EEE9DD',
      ink: '#1C1A17', 'ink-2': '#4A4640', 'ink-3': '#8A857A',
      accent: '#B85C2E', 'accent-bg': '#F5E4D6',
      positive: '#3F7A4D', warning: '#A8761B', danger: '#B43A2E',
    },
    dark: {
      bg: '#161410', surface: '#1F1C17', sunken: '#0F0E0B',
      line: '#2E2A23', 'line-soft': '#26221C', chip: '#2A2620',
      ink: '#F2EEE5', 'ink-2': '#B8B2A4', 'ink-3': '#7A7468',
      accent: '#E08A52', 'accent-bg': '#3A2418',
      positive: '#7DB18A', warning: '#D6A65A', danger: '#E27666',
    },
  },
  graphite: {
    light: {
      bg: '#F7F8FA', surface: '#FFFFFF', sunken: '#EEF0F4',
      line: '#E1E4EA', 'line-soft': '#ECEEF2', chip: '#EEF0F4',
      ink: '#0E1116', 'ink-2': '#3A4252', 'ink-3': '#7A8294',
      accent: '#4F46E5', 'accent-bg': '#EEF0FF',
      positive: '#197A4F', warning: '#A66A00', danger: '#C2342B',
    },
    dark: {
      bg: '#0B0D11', surface: '#14171D', sunken: '#070809',
      line: '#222731', 'line-soft': '#1A1E26', chip: '#1B1F27',
      ink: '#EEF1F6', 'ink-2': '#A8B0BF', 'ink-3': '#6A7388',
      accent: '#8B86FF', 'accent-bg': '#1B1B40',
      positive: '#74D29A', warning: '#E6B25F', danger: '#F26B5E',
    },
  },
  plot: {
    light: {
      bg: '#F4F1EA', surface: '#FFFDF7', sunken: '#EBE6DB',
      line: '#D8D2C2', 'line-soft': '#E4DFD0', chip: '#EBE6DB',
      ink: '#15140F', 'ink-2': '#4D483C', 'ink-3': '#8A8474',
      accent: '#6B2E48', 'accent-bg': '#F0DDE3',
      positive: '#3A6E4A', warning: '#8E6A1F', danger: '#A93128',
    },
    dark: {
      bg: '#13110D', surface: '#1C1914', sunken: '#0D0B08',
      line: '#2E2A22', 'line-soft': '#241F1A', chip: '#252119',
      ink: '#F1ECDF', 'ink-2': '#B8B19E', 'ink-3': '#7C7665',
      accent: '#D88AA0', 'accent-bg': '#3A1E2A',
      positive: '#80C190', warning: '#D8AE6E', danger: '#E27566',
    },
  },
};

// ─── Font pairings ───────────────────────────────────────────────
// Use expo-font / expo-google-fonts to load these. Fallbacks listed.
export const fonts: Record<Variant, FontStack> = {
  paper: {
    // iA Writer Quattro is licensed; fall back to JetBrains Mono if you can't ship it
    display: 'iAWriterQuattroV, JetBrainsMono, Menlo, monospace',
    body:    'iAWriterQuattroV, Inter, System, sans-serif',
    mono:    'JetBrainsMono, Menlo, monospace',
  },
  graphite: {
    display: 'InterTight, Inter, System, sans-serif',
    body:    'Inter, System, sans-serif',
    mono:    'JetBrainsMono, Menlo, monospace',
  },
  plot: {
    display: 'Newsreader, Georgia, serif',
    body:    'Inter, System, sans-serif',
    mono:    'JetBrainsMono, Menlo, monospace',
  },
};

// ─── Density ─────────────────────────────────────────────────────
export const density = {
  compact:     { rowH: 44, sectionGap: 22, cellPadY: 10, cellPadX: 14 },
  comfortable: { rowH: 56, sectionGap: 30, cellPadY: 14, cellPadX: 16 },
} as const;

// ─── Shadows / motion ────────────────────────────────────────────
export const shadow = {
  sm: { shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 2, shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  md: { shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 3 },
  lg: { shadowColor: '#000', shadowOpacity: 0.10, shadowRadius: 32, shadowOffset: { width: 0, height: 8 }, elevation: 8 },
} as const;

export const motion = {
  fast: 120, base: 180, slow: 280, // ms
  easing: [0.2, 0, 0, 1] as [number, number, number, number],
};

// ─── Token resolver ──────────────────────────────────────────────
export function resolveTheme(variant: Variant, mode: Mode, fontOverride?: Variant) {
  return {
    ...palettes[variant][mode],
    fonts: fonts[fontOverride ?? variant],
    variant, mode,
  };
}

export type Theme = ReturnType<typeof resolveTheme>;
