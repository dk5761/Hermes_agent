/**
 * NavIcon — 36x36 Pressable for nav-bar slots (matches ui.jsx::NavIcon).
 * Optional 8px badge dot (accent) sits top-right with bg-bg outline.
 */
import React from "react";
import { Pressable, View } from "react-native";
import { Icon, type IconName } from "./Icon";
import { useThemeTokens } from "./tokens";

export interface NavIconProps {
  name: IconName;
  onClick?: () => void;
  onPress?: () => void;
  badge?: boolean;
}

export function NavIcon({ name, onClick, onPress, badge }: NavIconProps) {
  const tokens = useThemeTokens();
  const handler = onClick ?? onPress;
  return (
    <Pressable
      onPress={handler}
      style={{
        width: 36,
        height: 36,
        borderRadius: 10,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Icon name={name} size={20} color={tokens.ink} />
      {badge ? (
        <View
          style={{
            position: "absolute",
            top: 6,
            right: 6,
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: tokens.accent,
            borderWidth: 2,
            borderColor: tokens.bg,
          }}
        />
      ) : null}
    </Pressable>
  );
}
