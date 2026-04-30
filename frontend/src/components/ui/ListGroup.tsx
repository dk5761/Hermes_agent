/**
 * ListGroup — rounded card with optional header + dividers between rows
 * (matches ui.jsx::ListGroup).
 *
 * The bottom border between rows uses `border-line-soft`. We render each
 * child inside a wrapping View whose bottom border is conditionally applied.
 */
import React from "react";
import { View } from "react-native";
import { Stack } from "./Stack";
import { Text } from "./Text";

export interface ListGroupProps {
  header?: string;
  footer?: string;
  children?: React.ReactNode;
}

export function ListGroup({ header, footer, children }: ListGroupProps) {
  const items = React.Children.toArray(children);
  return (
    <Stack gap={8}>
      {header ? (
        <Text
          kind="micro"
          className="text-ink-3 uppercase"
          style={{ paddingHorizontal: 16 }}
        >
          {header}
        </Text>
      ) : null}
      <View
        className="bg-surface border border-line overflow-hidden"
        style={{ borderRadius: 14, marginHorizontal: 16 }}
      >
        {items.map((c, i) => (
          <View
            key={i}
            className={i < items.length - 1 ? "border-b border-line-soft" : ""}
          >
            {c}
          </View>
        ))}
      </View>
      {footer ? (
        <Text
          kind="caption"
          className="text-ink-3"
          style={{ paddingHorizontal: 16 }}
        >
          {footer}
        </Text>
      ) : null}
    </Stack>
  );
}
