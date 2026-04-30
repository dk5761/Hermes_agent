import { forwardRef, type Ref } from "react";
import { StyleSheet, Text, TextInput, type TextInputProps, View } from "react-native";
import { BORDER, MUTED, PANEL, TEXT } from "../config";

interface TextFieldProps extends TextInputProps {
  label?: string;
  error?: string;
}

function TextFieldInner(
  { label, error, style, ...rest }: TextFieldProps,
  ref: Ref<TextInput>,
) {
  return (
    <View style={styles.wrap}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <TextInput
        ref={ref}
        placeholderTextColor={MUTED}
        style={[styles.input, error ? styles.inputError : null, style]}
        autoCapitalize="none"
        autoCorrect={false}
        {...rest}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

export const TextField = forwardRef<TextInput, TextFieldProps>(TextFieldInner);

const styles = StyleSheet.create({
  wrap: {
    gap: 6,
  },
  label: {
    color: MUTED,
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  input: {
    backgroundColor: PANEL,
    borderWidth: 1,
    borderColor: BORDER,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: TEXT,
    fontSize: 16,
    minHeight: 44,
  },
  inputError: {
    borderColor: "#5A1A22",
  },
  error: {
    color: "#FCA5A5",
    fontSize: 12,
  },
});
