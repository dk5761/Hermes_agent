/**
 * Field — label + child + hint/error wrapper (matches ui.jsx::Field).
 * Error wins over hint and renders in danger color.
 */
import React from "react";
import { Stack } from "./Stack";
import { Text } from "./Text";

export interface FieldProps {
  label?: string;
  hint?: string;
  error?: string;
  mono?: boolean;
  children?: React.ReactNode;
}

export function Field({ label, hint, error, mono, children }: FieldProps) {
  const message = error ?? hint;
  return (
    <Stack gap={6} style={{ width: "100%" }}>
      {label ? (
        <Text
          kind="micro"
          className="text-ink-3 uppercase"
        >
          {label}
        </Text>
      ) : null}
      {children}
      {message ? (
        <Text
          kind="caption"
          mono={mono}
          className={error ? "text-danger" : "text-ink-3"}
        >
          {message}
        </Text>
      ) : null}
    </Stack>
  );
}
