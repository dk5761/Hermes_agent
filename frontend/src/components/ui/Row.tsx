/**
 * Row — horizontal flex layout (matches ui.jsx::Row).
 * Defaults: align="center", justify="flex-start" (per design source).
 */
import React from "react";
import { View, type ViewProps, type ViewStyle, type StyleProp } from "react-native";

export interface RowProps extends Omit<ViewProps, "style"> {
  gap?: number;
  align?: ViewStyle["alignItems"];
  justify?: ViewStyle["justifyContent"];
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

export function Row({
  gap = 0,
  align = "center",
  justify = "flex-start",
  style,
  children,
  ...rest
}: RowProps) {
  return (
    <View
      style={[
        { flexDirection: "row", alignItems: align, justifyContent: justify, gap },
        style,
      ]}
      {...rest}
    >
      {children}
    </View>
  );
}
