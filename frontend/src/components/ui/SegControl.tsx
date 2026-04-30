/**
 * SegControl — iOS-style segmented control (matches ui.jsx::SegControl).
 * Active segment uses bg-surface + subtle shadow; track uses bg-sunken.
 */
import React from "react";
import { Pressable, View } from "react-native";
import { Text } from "./Text";

export type SegOption =
  | string
  | {
      value: string;
      label: string;
    };

export interface SegControlProps {
  options: ReadonlyArray<SegOption>;
  value: string;
  onChange: (next: string) => void;
}

export function SegControl({ options, value, onChange }: SegControlProps) {
  return (
    <View
      className="flex-row bg-sunken border border-line-soft"
      style={{ borderRadius: 10, padding: 3, gap: 2 }}
    >
      {options.map((opt) => {
        const k = typeof opt === "string" ? opt : opt.value;
        const lbl = typeof opt === "string" ? opt : opt.label;
        const active = value === k;
        return (
          <Pressable
            key={k}
            onPress={() => onChange(k)}
            className={
              "flex-1 items-center justify-center" +
              (active ? " bg-surface" : "")
            }
            style={{
              height: 30,
              paddingHorizontal: 12,
              borderRadius: 7,
              // Soft shadow only on the active segment to lift it from track.
              shadowColor: active ? "#000" : undefined,
              shadowOpacity: active ? 0.06 : 0,
              shadowRadius: active ? 2 : 0,
              shadowOffset: { width: 0, height: 1 },
              elevation: active ? 1 : 0,
            }}
          >
            <Text
              kind="label"
              className={active ? "text-ink" : "text-ink-2"}
              style={{ fontWeight: active ? "600" : "500", fontSize: 13 }}
            >
              {lbl}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
