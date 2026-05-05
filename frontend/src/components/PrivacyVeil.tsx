/**
 * PrivacyVeil — blocks the iOS App Switcher / multitasking preview from
 * leaking chat content. Mounts a full-screen blur over the app whenever
 * AppState reports anything other than "active". Independent of app-lock:
 * runs even when biometric lock is disabled, because the threat model
 * (preventing a casual onlooker from screenshotting the App Switcher row)
 * is universal for a private-conversations app.
 *
 * The blur paints synchronously on the JS thread when AppState transitions
 * to "inactive" — iOS fires that event on the press of the home indicator
 * before "background", so the system snapshot captures the blurred frame.
 *
 * Lives at the very top of the root tree (above AppLockOverlay) so it
 * blankets login screens, modals, and the lock overlay alike.
 */
import { useEffect, useState } from "react";
import { AppState, type AppStateStatus, StyleSheet, View } from "react-native";
import { BlurView } from "expo-blur";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { HermesMark } from "./ui/HermesMark";
import { Stack } from "./ui/Stack";
import { Text } from "./ui/Text";
import { useTheme } from "@/theme";

export function PrivacyVeil() {
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);
  const insets = useSafeAreaInsets();
  // resolvedMode lands at "light" | "dark" — needed because BlurView's `tint`
  // prop accepts those discrete values, not the "system" pass-through.
  const { resolvedMode } = useTheme();

  useEffect(() => {
    const sub = AppState.addEventListener("change", setAppState);
    return () => sub.remove();
  }, []);

  // Render only when the app isn't in the foreground. Mounting/unmounting
  // (rather than always-mounted with display:none) avoids the BlurView's
  // GPU work entirely while the user is actively using the app.
  if (appState === "active") return null;

  return (
    <View
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      // Highest z-index in the tree; sits above AppLockOverlay (mounted
      // last under PrivacyVeil's parent in _layout.tsx).
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <BlurView
        intensity={60}
        tint={resolvedMode}
        style={StyleSheet.absoluteFill}
      >
        <Stack
          align="center"
          justify="center"
          gap={12}
          style={{
            flex: 1,
            paddingTop: insets.top,
            paddingBottom: insets.bottom,
          }}
        >
          <HermesMark size={48} />
          <Text kind="caption" className="text-ink-3">
            Hermes
          </Text>
        </Stack>
      </BlurView>
    </View>
  );
}
