/**
 * PhoneSafeArea — flex-1 bg-bg wrapper with safe-area edges.
 * Mirrors `PhoneScreen` from screens-1.jsx.
 *
 * Default edges = ["bottom"] only. The NavBar handles its own top inset
 * (so the bg-bg color extends behind the notch / status bar). Including
 * "top" here would double-count the inset and create dead space above
 * NavBar's title. Screens without a NavBar should pass edges={["top","bottom"]}
 * explicitly.
 *
 * Background is applied via inline style (using runtime hex from
 * useThemeTokens) instead of `bg-bg` className. SafeAreaView from
 * react-native-safe-area-context isn't a built-in RN component, so Uniwind's
 * className augmentation may silently no-op on some versions — inline style
 * is bulletproof.
 */
import React from "react";
import { type StyleProp, type ViewStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeTokens } from "./tokens";

export interface PhoneSafeAreaProps {
  children?: React.ReactNode;
  /** Defaults to ['bottom']. Pass ['top','bottom'] for screens without a NavBar. */
  edges?: ReadonlyArray<"top" | "bottom" | "left" | "right">;
  style?: StyleProp<ViewStyle>;
}

export function PhoneSafeArea({
  children,
  edges = ["bottom"],
  style,
}: PhoneSafeAreaProps) {
  const tokens = useThemeTokens();
  return (
    <SafeAreaView
      edges={edges as ReadonlyArray<"top" | "bottom" | "left" | "right">}
      style={[{ flex: 1, backgroundColor: tokens.bg }, style]}
    >
      {children}
    </SafeAreaView>
  );
}
