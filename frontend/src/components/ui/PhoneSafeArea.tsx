/**
 * PhoneSafeArea — flex-1 bg-bg View wrapped in SafeAreaView (top + bottom).
 * Mirrors `PhoneScreen` from screens-1.jsx.
 */
import React from "react";
import { type StyleProp, type ViewStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export interface PhoneSafeAreaProps {
  children?: React.ReactNode;
  /** Defaults to ['top', 'bottom']. */
  edges?: ReadonlyArray<"top" | "bottom" | "left" | "right">;
  style?: StyleProp<ViewStyle>;
}

export function PhoneSafeArea({
  children,
  edges = ["top", "bottom"],
  style,
}: PhoneSafeAreaProps) {
  return (
    <SafeAreaView
      className="flex-1 bg-bg"
      edges={edges as ReadonlyArray<"top" | "bottom" | "left" | "right">}
      style={style}
    >
      {children}
    </SafeAreaView>
  );
}
