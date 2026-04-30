import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Slot } from "expo-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { useAuthRedirect } from "@/auth/hooks";
import { useAuthStore } from "@/auth/store";
import { BG, MUTED } from "@/config";

// One client per app instance; React Query cache is in-memory only this phase
// (TODO Phase 3.5: AsyncStorage persister for warm-start).
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

function AuthGate() {
  const hydrated = useAuthStore((s) => s.hydrated);
  const hydrate = useAuthStore((s) => s.hydrate);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useAuthRedirect();

  if (!hydrated) {
    return (
      <View style={styles.splash}>
        <ActivityIndicator color={MUTED} />
      </View>
    );
  }
  return <Slot />;
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <StatusBar style="light" />
        <AuthGate />
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    backgroundColor: BG,
    alignItems: "center",
    justifyContent: "center",
  },
});
