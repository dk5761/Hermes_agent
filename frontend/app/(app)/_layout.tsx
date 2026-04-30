import { Stack } from "expo-router";
import { BG, TEXT } from "@/config";

export default function AppLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: BG },
        headerTintColor: TEXT,
        headerTitleStyle: { color: TEXT },
        contentStyle: { backgroundColor: BG },
      }}
    >
      <Stack.Screen name="index" options={{ title: "Sessions" }} />
      <Stack.Screen name="chat/[id]" options={{ title: "" }} />
      <Stack.Screen name="settings" options={{ title: "Settings" }} />
    </Stack>
  );
}
