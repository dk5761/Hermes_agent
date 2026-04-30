/**
 * Font loading for Hermes.
 *
 * Loads the four type families used across the three theme variants:
 *   - Inter           (body, all variants)
 *   - Inter Tight     (display, Graphite variant)
 *   - Newsreader      (display, Plot variant)
 *   - JetBrains Mono  (mono everywhere, also display for Paper since
 *                      iA Writer Quattro V is licensed)
 *
 * Returns `[loaded, error]`. Root layout gates rendering on `loaded`.
 *
 * IMPORTANT: keys here MUST match the font-family names used in
 * `frontend/global.css` (`--font-display`, `--font-body`, `--font-mono`).
 * React Native looks up the fontFamily by exact string match.
 */
import { useFonts } from "expo-font";
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
} from "@expo-google-fonts/inter";
import {
  InterTight_500Medium,
  InterTight_600SemiBold,
} from "@expo-google-fonts/inter-tight";
import {
  Newsreader_400Regular,
  Newsreader_600SemiBold,
} from "@expo-google-fonts/newsreader";
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
} from "@expo-google-fonts/jetbrains-mono";

export function useAppFonts(): [boolean, Error | null] {
  // Keys are the exact strings used in the CSS font stacks. RN matches
  // fontFamily by string, so "Inter Tight" with a space (not the
  // Inter_Tight_500Medium key) is what we register.
  const [loaded, error] = useFonts({
    Inter: Inter_400Regular,
    "Inter-Medium": Inter_500Medium,
    "Inter-SemiBold": Inter_600SemiBold,
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,

    "Inter Tight": InterTight_500Medium,
    "Inter Tight-SemiBold": InterTight_600SemiBold,
    InterTight_500Medium,
    InterTight_600SemiBold,

    Newsreader: Newsreader_400Regular,
    "Newsreader-SemiBold": Newsreader_600SemiBold,
    Newsreader_400Regular,
    Newsreader_600SemiBold,

    "JetBrains Mono": JetBrainsMono_400Regular,
    "JetBrains Mono-Medium": JetBrainsMono_500Medium,
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
  });

  return [loaded, error];
}
