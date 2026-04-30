/**
 * Section — uppercase eyebrow + optional action slot (matches ui.jsx::Section).
 * Density-aware vertical gap: comfortable=10, compact=8 (per spec).
 */
import React from "react";
import { useTheme } from "@/theme";
import { Row } from "./Row";
import { Stack } from "./Stack";
import { Text } from "./Text";

export interface SectionProps {
  title: string;
  action?: React.ReactNode;
  children?: React.ReactNode;
}

export function Section({ title, action, children }: SectionProps) {
  const { density } = useTheme();
  // Density rule: section gap differs between compact / comfortable.
  const gap = density === "comfortable" ? 10 : 8;
  return (
    <Stack gap={gap}>
      <Row
        align="center"
        justify="space-between"
        style={{ paddingHorizontal: 16 }}
      >
        <Text kind="micro" className="text-ink-3 uppercase">
          {title}
        </Text>
        {action}
      </Row>
      {children}
    </Stack>
  );
}
