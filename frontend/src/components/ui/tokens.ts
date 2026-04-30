/**
 * tokens.ts — runtime hex resolution for the active theme.
 *
 * Uniwind drives bg-X / text-X / border-X utilities, but a few primitives
 * (Icon stroke color, animated thumb fill, Reanimated style props) need a
 * literal hex string at runtime because RN SVG / Reanimated worklets cannot
 * read CSS variables.
 *
 * We mirror the per-variant palettes from `global.css` here. This stays
 * in sync by inspection; if `global.css` changes, update this file too.
 */
import { useMemo } from "react";
import { useTheme, type Variant, type Mode } from "@/theme";

export interface ThemeTokens {
  bg: string;
  surface: string;
  sunken: string;
  line: string;
  lineSoft: string;
  chip: string;
  ink: string;
  ink2: string;
  ink3: string;
  accent: string;
  accentBg: string;
  positive: string;
  warning: string;
  danger: string;
}

const PALETTES: Record<`${Variant}-${Mode}`, ThemeTokens> = {
  "paper-light": {
    bg: "#FAF8F4",
    surface: "#FFFFFF",
    sunken: "#F2EEE6",
    line: "#E5DFD2",
    lineSoft: "#EFEAE0",
    chip: "#EEE9DD",
    ink: "#1C1A17",
    ink2: "#4A4640",
    ink3: "#8A857A",
    accent: "#B85C2E",
    accentBg: "#F5E4D6",
    positive: "#3F7A4D",
    warning: "#A8761B",
    danger: "#B43A2E",
  },
  "paper-dark": {
    bg: "#161410",
    surface: "#1F1C17",
    sunken: "#0F0E0B",
    line: "#2E2A23",
    lineSoft: "#26221C",
    chip: "#2A2620",
    ink: "#F2EEE5",
    ink2: "#B8B2A4",
    ink3: "#7A7468",
    accent: "#E08A52",
    accentBg: "#3A2418",
    positive: "#7DB18A",
    warning: "#D6A65A",
    danger: "#E27666",
  },
  "graphite-light": {
    bg: "#F7F8FA",
    surface: "#FFFFFF",
    sunken: "#EEF0F4",
    line: "#E1E4EA",
    lineSoft: "#ECEEF2",
    chip: "#EEF0F4",
    ink: "#0E1116",
    ink2: "#3A4252",
    ink3: "#7A8294",
    accent: "#4F46E5",
    accentBg: "#EEF0FF",
    positive: "#197A4F",
    warning: "#A66A00",
    danger: "#C2342B",
  },
  "graphite-dark": {
    bg: "#0B0D11",
    surface: "#14171D",
    sunken: "#070809",
    line: "#222731",
    lineSoft: "#1A1E26",
    chip: "#1B1F27",
    ink: "#EEF1F6",
    ink2: "#A8B0BF",
    ink3: "#6A7388",
    accent: "#8B86FF",
    accentBg: "#1B1B40",
    positive: "#74D29A",
    warning: "#E6B25F",
    danger: "#F26B5E",
  },
  "plot-light": {
    bg: "#F4F1EA",
    surface: "#FFFDF7",
    sunken: "#EBE6DB",
    line: "#D8D2C2",
    lineSoft: "#E4DFD0",
    chip: "#EBE6DB",
    ink: "#15140F",
    ink2: "#4D483C",
    ink3: "#8A8474",
    accent: "#6B2E48",
    accentBg: "#F0DDE3",
    positive: "#3A6E4A",
    warning: "#8E6A1F",
    danger: "#A93128",
  },
  "plot-dark": {
    bg: "#13110D",
    surface: "#1C1914",
    sunken: "#0D0B08",
    line: "#2E2A22",
    lineSoft: "#241F1A",
    chip: "#252119",
    ink: "#F1ECDF",
    ink2: "#B8B19E",
    ink3: "#7C7665",
    accent: "#D88AA0",
    accentBg: "#3A1E2A",
    positive: "#80C190",
    warning: "#D8AE6E",
    danger: "#E27566",
  },
};

/** Returns the literal hex tokens for the currently-active theme. */
export function useThemeTokens(): ThemeTokens {
  const { variant, mode } = useTheme();
  return useMemo(() => PALETTES[`${variant}-${mode}`], [variant, mode]);
}
