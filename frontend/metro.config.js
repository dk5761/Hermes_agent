// Metro configuration for Expo + Uniwind v1.6.3 + Tailwind v4.
// `withUniwindConfig` MUST be the outermost wrapper (per Uniwind docs).
const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");

const config = getDefaultConfig(__dirname);

module.exports = withUniwindConfig(config, {
  cssEntryFile: "./global.css",
  dtsFile: "./uniwind-types.d.ts",
  // The `light` and `dark` themes are registered automatically by Uniwind.
  // Register our six custom themes here so they emit `@custom-variant <name>`
  // and so `Uniwind.setTheme("graphite-light")` is permitted at runtime.
  extraThemes: [
    "paper-light",
    "paper-dark",
    "graphite-light",
    "graphite-dark",
    "plot-light",
    "plot-dark",
  ],
});
