/**
 * Stack — vertical flex layout with `gap` (matches ui.jsx::Stack).
 *
 * `gap` is passed through View `style` because Tailwind's static gap classes
 * can't take an arbitrary number prop; this preserves the exact API of the
 * web prototype while staying RN-native.
 */
import React from "react";
import { View, type ViewProps, type ViewStyle, type StyleProp } from "react-native";

export interface StackProps extends Omit<ViewProps, "style"> {
  gap?: number;
  align?: ViewStyle["alignItems"];
  justify?: ViewStyle["justifyContent"];
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

export function Stack({
  gap = 0,
  align,
  justify,
  style,
  children,
  ...rest
}: StackProps) {
  return (
    <View
      style={[
        { flexDirection: "column", gap, alignItems: align, justifyContent: justify },
        style,
      ]}
      {...rest}
    >
      {children}
    </View>
  );
}
