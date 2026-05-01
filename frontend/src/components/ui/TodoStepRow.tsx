/**
 * TodoStepRow — single step inside a TodoPlanCard.
 *
 * Status visuals are inline (View-based) rather than via the Icon set so the
 * filled circle / bullseye / strikethrough states render in pure RN without
 * relying on glyphs that don't exist in the 40-icon set.
 */
import React from "react";
import { View } from "react-native";
import { Icon } from "./Icon";
import { Row } from "./Row";
import { Text } from "./Text";
import { useThemeTokens } from "./tokens";

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

export interface TodoStepRowProps {
  item: TodoItem;
}

function StatusIcon({ status }: { status: TodoStatus }) {
  const tokens = useThemeTokens();
  switch (status) {
    case "pending":
      return (
        <View
          style={{
            width: 18,
            height: 18,
            borderRadius: 9,
            borderWidth: 1.5,
            borderColor: tokens.ink3,
          }}
        />
      );
    case "in_progress":
      // Bullseye: outer ring + inner solid disc, both accent.
      return (
        <View
          style={{
            width: 18,
            height: 18,
            borderRadius: 9,
            borderWidth: 1.5,
            borderColor: tokens.accent,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: tokens.accent,
            }}
          />
        </View>
      );
    case "completed":
      return (
        <View
          style={{
            width: 18,
            height: 18,
            borderRadius: 9,
            backgroundColor: tokens.positive,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="check" size={12} color={tokens.surface} />
        </View>
      );
    case "cancelled":
      return (
        <View
          style={{
            width: 18,
            height: 18,
            borderRadius: 9,
            backgroundColor: tokens.ink3,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="close" size={12} color={tokens.surface} />
        </View>
      );
  }
}

function NowPill() {
  const tokens = useThemeTokens();
  return (
    <View
      className="bg-accent-bg"
      style={{
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 999,
      }}
    >
      <Text kind="micro" color={tokens.accent} style={{ fontWeight: "600" }}>
        now
      </Text>
    </View>
  );
}

export function TodoStepRow({ item }: TodoStepRowProps) {
  const tokens = useThemeTokens();
  const dimmed = item.status === "completed" || item.status === "cancelled";
  return (
    <Row
      gap={10}
      align="center"
      style={{ paddingHorizontal: 14, paddingVertical: 10 }}
    >
      <StatusIcon status={item.status} />
      <Text
        kind="body"
        color={dimmed ? tokens.ink3 : tokens.ink}
        numberOfLines={2}
        style={{
          flex: 1,
          textDecorationLine: dimmed ? "line-through" : "none",
        }}
      >
        {item.content}
      </Text>
      {item.status === "in_progress" ? <NowPill /> : null}
    </Row>
  );
}
