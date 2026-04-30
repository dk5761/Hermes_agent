// EXPO_PUBLIC_* env vars are inlined at build time by Expo so they're safe to
// read at module scope. Defaults target a local backend during development.

const DEFAULT_API_URL = "http://127.0.0.1:8080";
const DEFAULT_WS_URL = "ws://127.0.0.1:8080";

export const API_URL: string =
  process.env.EXPO_PUBLIC_API_URL?.trim() || DEFAULT_API_URL;

export const WS_URL: string =
  process.env.EXPO_PUBLIC_WS_URL?.trim() || DEFAULT_WS_URL;

export const ACCENT = "#2C6BED";
export const BG = "#000000";
export const PANEL = "#0F1115";
export const ROW = "#171A20";
export const TEXT = "#E8EAED";
export const MUTED = "#8A8F98";
export const DANGER = "#E5484D";
export const BORDER = "#23262D";
