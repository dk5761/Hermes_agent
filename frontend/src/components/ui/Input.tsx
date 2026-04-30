/**
 * Input — single-line TextInput with optional left icon + right slot
 * (matches ui.jsx::Input).
 *
 * Focus border switches from `border-line` to `border-ink-2` (uses runtime
 * hex from tokens because Tailwind class swap on focus is awkward in RN).
 */
import React, { useState } from "react";
import {
  TextInput,
  View,
  type TextInputProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Icon, type IconName } from "./Icon";
import { useThemeTokens } from "./tokens";

export interface InputProps {
  value?: string;
  onChange?: (next: string) => void;
  placeholder?: string;
  mono?: boolean;
  type?: "text" | "email" | "password" | "number";
  icon?: IconName;
  right?: React.ReactNode;
  autoFocus?: boolean;
  onSubmit?: () => void;
  secureTextEntry?: boolean;
  style?: StyleProp<ViewStyle>;
  /** Optional pass-through for less-common props. */
  textInputProps?: Omit<TextInputProps, "value" | "onChangeText" | "placeholder">;
}

export function Input({
  value,
  onChange,
  placeholder,
  mono,
  type = "text",
  icon,
  right,
  autoFocus,
  onSubmit,
  secureTextEntry,
  style,
  textInputProps,
}: InputProps) {
  const tokens = useThemeTokens();
  const [focused, setFocused] = useState(false);

  const keyboardType =
    type === "email" ? "email-address" : type === "number" ? "numeric" : "default";
  const isSecure = secureTextEntry ?? type === "password";

  return (
    <View
      className="flex-row items-center bg-surface"
      style={[
        {
          height: 44,
          paddingHorizontal: 12,
          borderRadius: 10,
          gap: 8,
          borderWidth: 1,
          borderColor: focused ? tokens.ink2 : tokens.line,
        },
        style,
      ]}
    >
      {icon ? <Icon name={icon} size={16} color={tokens.ink3} /> : null}
      <TextInput
        value={value ?? ""}
        onChangeText={(t) => onChange?.(t)}
        placeholder={placeholder}
        placeholderTextColor={tokens.ink3}
        autoFocus={autoFocus}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onSubmitEditing={onSubmit}
        secureTextEntry={isSecure}
        keyboardType={keyboardType}
        autoCapitalize={type === "email" ? "none" : undefined}
        autoCorrect={type === "email" ? false : undefined}
        style={{
          flex: 1,
          fontSize: 15,
          letterSpacing: -0.1,
          color: tokens.ink,
          fontFamily: mono ? "JetBrainsMono_400Regular" : "Inter_400Regular",
          paddingVertical: 0,
        }}
        {...textInputProps}
      />
      {right}
    </View>
  );
}
