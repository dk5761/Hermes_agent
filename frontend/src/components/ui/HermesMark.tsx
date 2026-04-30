/**
 * HermesMark — winged-H wordmark (verbatim port of ui.jsx::HermesMark).
 */
import React from "react";
import Svg, { Circle, Path } from "react-native-svg";
import { useThemeTokens } from "./tokens";

export interface HermesMarkProps {
  size?: number;
  /** Hex string. Defaults to theme ink. */
  color?: string;
}

export function HermesMark({ size = 24, color }: HermesMarkProps) {
  const tokens = useThemeTokens();
  const c = color ?? tokens.ink;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={12} r={11} stroke={c} strokeWidth={1.4} />
      <Path
        d="M8 7v10M16 7v10M8 12h8"
        stroke={c}
        strokeWidth={1.6}
        strokeLinecap="round"
      />
      <Path
        d="M5 9l-2 1M5 12l-2 0M5 15l-2 1M19 9l2 1M19 12l2 0M19 15l2 1"
        stroke={c}
        strokeWidth={1.2}
        strokeLinecap="round"
        opacity={0.5}
      />
    </Svg>
  );
}
