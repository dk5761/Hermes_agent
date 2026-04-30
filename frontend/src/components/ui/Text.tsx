/**
 * Text — typed wrapper over RN <Text> with type-scale `kind` prop.
 *
 * `kind` maps to one of our 10 utility classes (text-display .. text-mono).
 * `mono` swaps the font family to JetBrains Mono.
 * `color` is a hex string passed via `style.color` because RN <Text> can't
 * accept dynamic Tailwind color classes (the class set is statically scanned).
 */
import React from "react";
import {
  Text as RNText,
  type TextProps as RNTextProps,
  type StyleProp,
  type TextStyle,
} from "react-native";

export type TextKind =
  | "display"
  | "h1"
  | "h2"
  | "h3"
  | "body-lg"
  | "body"
  | "label"
  | "caption"
  | "micro"
  | "mono";

const KIND_CLASS: Record<TextKind, string> = {
  display: "text-display",
  h1: "text-h1",
  h2: "text-h2",
  h3: "text-h3",
  "body-lg": "text-body-lg",
  body: "text-body",
  label: "text-label",
  caption: "text-caption",
  micro: "text-micro",
  mono: "text-mono",
};

// Display + h1 use the variant's display font; everything else uses body.
// Listed inline so the Uniwind compiler sees both class names.
const DISPLAY_KINDS: ReadonlySet<TextKind> = new Set(["display", "h1"]);

export interface TextProps extends Omit<RNTextProps, "style"> {
  kind?: TextKind;
  mono?: boolean;
  color?: string;
  className?: string;
  style?: StyleProp<TextStyle>;
  children?: React.ReactNode;
}

export function Text({
  kind = "body",
  mono = false,
  color,
  className,
  style,
  children,
  ...rest
}: TextProps) {
  const fontClass = mono
    ? "font-mono"
    : DISPLAY_KINDS.has(kind)
      ? "font-display"
      : "font-body";
  // Default ink color comes from `text-ink`; an explicit `color` prop wins.
  const colorClass = color ? "" : "text-ink";
  const cls = `${KIND_CLASS[kind]} ${fontClass} ${colorClass}${className ? " " + className : ""}`;
  return (
    <RNText
      className={cls}
      style={[color ? { color } : null, style]}
      {...rest}
    >
      {children}
    </RNText>
  );
}
