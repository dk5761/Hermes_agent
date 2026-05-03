/**
 * Button — 5 kinds × 3 sizes (matches ui.jsx::Button).
 *
 * Uses Pressable for native-feeling press states. Sizes are inline because
 * Tailwind class strings can't drive both height + horizontal padding +
 * font-size from a single static literal at the same time.
 *
 * Accent kind needs different text contrast in light vs dark mode (per design):
 *   light → text-surface (white-ish)
 *   dark  → "#0E0B08" (near-black, fixed)
 */
import React, { useMemo } from "react";
import {
  Pressable,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useTheme } from "@/theme";
import { Icon, type IconName } from "./Icon";
import { Text } from "./Text";

export type ButtonKind = "primary" | "secondary" | "ghost" | "accent" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

interface SizeSpec {
  h: number;
  px: number;
  fs: number;
  gap: number;
  radius: number;
}

const SIZES: Record<ButtonSize, SizeSpec> = {
  sm: { h: 32, px: 12, fs: 13, gap: 6, radius: 8 },
  md: { h: 40, px: 14, fs: 15, gap: 8, radius: 10 },
  lg: { h: 48, px: 18, fs: 16, gap: 10, radius: 12 },
};

export interface ButtonProps
  extends Omit<PressableProps, "style" | "children" | "onPress"> {
  kind?: ButtonKind;
  size?: ButtonSize;
  leftIcon?: IconName;
  rightIcon?: IconName;
  full?: boolean;
  onClick?: () => void;
  /** Compatibility with RN Pressable callers. Aliased to `onClick`. */
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

export function Button({
  kind = "primary",
  size = "md",
  leftIcon,
  rightIcon,
  full,
  onClick,
  onPress,
  style,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  const { resolvedMode } = useTheme();
  const spec = SIZES[size];

  // Color logic mirrors ui.jsx::Button.kinds
  const variant = useMemo(() => {
    switch (kind) {
      case "primary":
        return { bgClass: "bg-ink", textColor: undefined, fgClass: "text-surface", border: false };
      case "secondary":
        return { bgClass: "bg-transparent", textColor: undefined, fgClass: "text-ink", border: true };
      case "ghost":
        return { bgClass: "bg-transparent", textColor: undefined, fgClass: "text-ink", border: false };
      case "accent":
        return {
          bgClass: "bg-accent",
          // Accent text contrast varies by mode (see file header).
          textColor: resolvedMode === "dark" ? "#0E0B08" : undefined,
          fgClass: resolvedMode === "dark" ? "" : "text-surface",
          border: false,
        };
      case "danger":
        return { bgClass: "bg-transparent", textColor: undefined, fgClass: "text-danger", border: true };
    }
  }, [kind, resolvedMode]);

  const handler = onClick ?? onPress;

  return (
    <Pressable
      onPress={handler}
      disabled={disabled}
      className={
        variant.bgClass +
        (variant.border ? " border border-line" : "") +
        " items-center justify-center flex-row"
      }
      style={[
        {
          height: spec.h,
          paddingHorizontal: spec.px,
          borderRadius: spec.radius,
          gap: spec.gap,
          opacity: disabled ? 0.5 : 1,
          width: full ? "100%" : undefined,
        },
        style,
      ]}
      {...rest}
    >
      {leftIcon && (
        <Icon
          name={leftIcon}
          size={spec.fs + 3}
          color={variant.textColor}
        />
      )}
      <Text
        kind="label"
        className={variant.fgClass}
        color={variant.textColor}
        style={{ fontSize: spec.fs, fontWeight: "500" }}
      >
        {children}
      </Text>
      {rightIcon && (
        <Icon
          name={rightIcon}
          size={spec.fs + 3}
          color={variant.textColor}
        />
      )}
    </Pressable>
  );
}
