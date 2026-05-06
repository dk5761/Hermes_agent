/**
 * BranchLoader — full-screen blocking overlay shown while POST /sessions/:id/branch
 * is in flight.
 *
 * Sits above the chat content but below the global PrivacyVeil (which renders
 * at the root of `app/_layout.tsx` and uses a higher zIndex). pointerEvents
 * is "auto" so taps are absorbed — branching is destructive enough that we
 * deliberately want the user to wait, and Hermes' /branch slash typically
 * completes well under 2s. The loader resolves itself when the API call
 * settles (the parent screen toggles a `branching` flag).
 *
 * No close button by design — see contract above.
 */
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { Stack, Text, useThemeTokens } from "@/components/ui";

export function BranchLoader(): React.JSX.Element {
  const tokens = useThemeTokens();
  return (
    <View
      pointerEvents="auto"
      accessibilityRole="progressbar"
      accessibilityLabel="Creating a copy of this chat"
      style={[
        StyleSheet.absoluteFillObject,
        {
          backgroundColor: tokens.bg,
          opacity: 0.97,
          alignItems: "center",
          justifyContent: "center",
          zIndex: 50,
        },
      ]}
    >
      <Stack gap={12} style={{ alignItems: "center", paddingHorizontal: 24 }}>
        <ActivityIndicator size="large" color={tokens.accent} />
        <Text kind="h3" style={{ textAlign: "center" }}>
          Creating a copy…
        </Text>
        <Text
          kind="caption"
          color={tokens.ink3}
          style={{ textAlign: "center" }}
        >
          Copying messages and Hermes context
        </Text>
      </Stack>
    </View>
  );
}
