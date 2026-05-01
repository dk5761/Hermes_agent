import { Stack } from "expo-router";
import { useThemeTokens } from "@/components/ui/tokens";

export default function AuthLayout() {
  // Pull bg from active theme so the auth shell follows variant + mode
  // (avoids hardcoded black showing through during sign-out).
  const tokens = useThemeTokens();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: tokens.bg },
      }}
    />
  );
}
