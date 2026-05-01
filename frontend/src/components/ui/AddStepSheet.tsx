/**
 * AddStepSheet — bottom-sheet input for appending a step to the active plan.
 *
 * The parent owns the open/closed boolean (so the same sheet can be reused for
 * multiple cards if we ever wire that). Submission validates non-empty +
 * length cap, then calls onSubmit with the trimmed content. The parent is
 * responsible for closing the sheet (typically immediately after submit).
 */
import React, { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { BottomSheetTextInput } from "@gorhom/bottom-sheet";

import { Button } from "./Button";
import { Row } from "./Row";
import { Sheet, type SheetHandle } from "./Sheet";
import { Stack } from "./Stack";
import { Text } from "./Text";
import { useThemeTokens } from "./tokens";

const MAX_LEN = 200;

export interface AddStepSheetProps {
  visible: boolean;
  onCancel: () => void;
  onSubmit: (content: string) => void;
}

export function AddStepSheet({ visible, onCancel, onSubmit }: AddStepSheetProps) {
  const tokens = useThemeTokens();
  const sheetRef = useRef<SheetHandle>(null);
  // BottomSheetTextInput's ref type leaks gesture-handler internals that don't
  // line up with RN's TextInput; we only need .focus() so the imperative shape
  // is sufficient.
  const inputRef = useRef<{ focus: () => void } | null>(null);
  const [value, setValue] = useState("");

  useEffect(() => {
    if (visible) {
      sheetRef.current?.present();
      // Slight delay so the keyboard animates in after the sheet, not before.
      const t = setTimeout(() => inputRef.current?.focus(), 250);
      return () => clearTimeout(t);
    }
    sheetRef.current?.dismiss();
    setValue("");
    return undefined;
  }, [visible]);

  const trimmed = value.trim();
  const valid = trimmed.length > 0 && trimmed.length <= MAX_LEN;

  return (
    <Sheet
      ref={sheetRef}
      snapPoints={["35%"]}
      onChange={(idx) => {
        // User swiped/backdrop-tapped to dismiss — propagate so parent state
        // matches the sheet's actual visibility.
        if (idx < 0 && visible) onCancel();
      }}
    >
      <Stack gap={12} style={{ paddingHorizontal: 20, paddingVertical: 12 }}>
        <Text kind="h3">Add step</Text>
        <View
          style={{
            borderWidth: 1,
            borderColor: tokens.line,
            borderRadius: 10,
            paddingHorizontal: 12,
            paddingVertical: 10,
            backgroundColor: tokens.surface,
          }}
        >
          {/* BottomSheetTextInput's ref expects gesture-handler's TextInput
              shape (different brand than RN's) — we erase the prop typing for
              the ref alone via spread to avoid an irrelevant cast chain. */}
          <BottomSheetTextInput
            {...({
              ref: inputRef,
            } as Record<string, unknown>)}
            value={value}
            onChangeText={(t) => setValue(t.slice(0, MAX_LEN))}
            placeholder="What's the next step?"
            placeholderTextColor={tokens.ink3}
            multiline={false}
            returnKeyType="done"
            onSubmitEditing={() => {
              if (valid) onSubmit(trimmed);
            }}
            style={{
              fontSize: 15,
              lineHeight: 20,
              color: tokens.ink,
              fontFamily: "Inter_400Regular",
              padding: 0,
            }}
          />
        </View>
        <Row gap={8} align="center" justify="space-between">
          <Text kind="caption" color={tokens.ink3}>
            {value.length}/{MAX_LEN}
          </Text>
          <Row gap={8} align="center">
            <Button kind="secondary" size="sm" onPress={onCancel}>
              Cancel
            </Button>
            <Button
              kind="accent"
              size="sm"
              disabled={!valid}
              onPress={() => onSubmit(trimmed)}
            >
              Add
            </Button>
          </Row>
        </Row>
      </Stack>
    </Sheet>
  );
}
