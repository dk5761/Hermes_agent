/**
 * PrivacyVeil — blocks the iOS App Switcher / multitasking preview from
 * leaking chat content.
 *
 * Critical timing detail: iOS captures the App Switcher snapshot during the
 * `applicationWillResignActive` → `applicationDidEnterBackground` window.
 * React Native bridges those to AppState as "active" → "inactive" →
 * "background". To beat the snapshot we MUST have the blur view already
 * mounted — mounting on the inactive event introduces a layout/paint race
 * that iOS often wins. So this component is permanently mounted at the
 * root, just hidden behind an opacity flip while the app is foregrounded.
 *
 * The opacity flip is layout-stable (no remount, no measure pass) and
 * tends to land in time. For a fully-bulletproof iOS-side blur we'd need
 * a native module that hooks `applicationWillResignActive` directly and
 * inserts a UIVisualEffectView into the key window before the snapshot —
 * a follow-up if this proves leaky in practice.
 *
 * Independent of app-lock: runs even when biometric lock is disabled.
 */
import { useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { HermesMark } from "./ui/HermesMark";
import { Stack } from "./ui/Stack";
import { Text } from "./ui/Text";

export function PrivacyVeil() {
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);
  const insets = useSafeAreaInsets();
  const stateRef = useRef(appState);
  stateRef.current = appState;

  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      // Only re-render when the bucket flips between "active" and not-active —
      // we don't care about the inactive↔background distinction here.
      const wasActive = stateRef.current === "active";
      const isActive = next === "active";
      if (wasActive !== isActive) setAppState(next);
    });
    return () => sub.remove();
  }, []);

  const visible = appState !== "active";

  return (
    <View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        {
          // Solid black, opacity-flipped rather than mount/unmount so the
          // view is already in the native tree when iOS snapshots the App
          // Switcher preview — beats the React render race.
          backgroundColor: "#000",
          opacity: visible ? 1 : 0,
        },
      ]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
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
        <HermesMark size={56} />
        <Text kind="caption" style={{ color: "rgba(255,255,255,0.5)" }}>
          Hermes
        </Text>
      </Stack>
    </View>
  );
}
