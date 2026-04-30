/**
 * MonoBlock — preformatted code box (matches ui.jsx::MonoBlock).
 * bg-sunken + line-soft border, font-mono caption-size text, padding 12.
 */
import React from "react";
import { View } from "react-native";
import { Text } from "./Text";

export interface MonoBlockProps {
  /** Optional text color override (hex). Defaults to ink-2. */
  color?: string;
  children?: React.ReactNode;
}

export function MonoBlock({ color, children }: MonoBlockProps) {
  return (
    <View
      className="bg-sunken border border-line-soft"
      style={{
        padding: 12,
        borderRadius: 10,
      }}
    >
      <Text
        kind="caption"
        mono
        color={color}
        className={color ? "" : "text-ink-2"}
        style={{ lineHeight: 18 }}
      >
        {children}
      </Text>
    </View>
  );
}
