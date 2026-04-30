import { Stack } from "expo-router";
import { BG } from "@/config";

export default function AuthLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: BG },
      }}
    />
  );
}
