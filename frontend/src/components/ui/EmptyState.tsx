/**
 * EmptyState — centered icon-tile + title + body + action
 * (matches ui.jsx::EmptyState).
 */
import React from "react";
import { View } from "react-native";
import { Icon, type IconName } from "./Icon";
import { Stack } from "./Stack";
import { Text } from "./Text";
import { useThemeTokens } from "./tokens";

export interface EmptyStateProps {
  icon?: IconName;
  title: string;
  body?: string;
  action?: React.ReactNode;
}

export function EmptyState({ icon = "doc", title, body, action }: EmptyStateProps) {
  const tokens = useThemeTokens();
  return (
    <Stack
      gap={12}
      align="center"
      style={{ paddingVertical: 60, paddingHorizontal: 24 }}
    >
      <View
        className="bg-chip"
        style={{
          width: 56,
          height: 56,
          borderRadius: 16,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon name={icon} size={26} color={tokens.ink2} />
      </View>
      <Stack gap={4} align="center">
        <Text kind="h3">{title}</Text>
        {body ? (
          <Text
            kind="body"
            className="text-ink-3"
            style={{ textAlign: "center", maxWidth: 280 }}
          >
            {body}
          </Text>
        ) : null}
      </Stack>
      {action}
    </Stack>
  );
}
