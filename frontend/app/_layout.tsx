// Stage 1: Uniwind + Tailwind v4 wiring. The CSS import MUST be the very
// first import — Uniwind's metro plugin discovers themes by parsing this
// file's resolved graph at bundle time.
import "../global.css";

import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Slot } from "expo-router";
import {
  MutationCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { useAuthRedirect } from "@/auth/hooks";
import { useAuthStore } from "@/auth/store";
import { useTodosUi } from "@/state/todos";
import { usePinnedSessions } from "@/state/pinned-sessions";
import { useNotificationsInbox } from "@/state/notifications-inbox";
import { BG, MUTED } from "@/config";
import { ThemeProvider, useAppFonts } from "@/theme";
import { ToastProvider, showToast } from "@/components/ui";
import { humanizeError } from "@/util/errors";

// One client per app instance; React Query cache is in-memory only this phase
// (TODO Phase 3.5: AsyncStorage persister for warm-start).
//
// Global mutation error handler: every mutation that doesn't suppress its
// onError fires a toast. Mutations that handle errors locally (auth flows,
// password change with inline messaging) can opt out by passing `meta:
// { silent: true }` on the useMutation call.
const queryClient = new QueryClient({
  mutationCache: new MutationCache({
    onError: (err, _variables, _context, mutation) => {
      if (mutation.meta && (mutation.meta as { silent?: boolean }).silent) {
        return;
      }
      showToast(humanizeError(err), "error");
    },
  }),
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
    // Pin/collapse state is non-blocking — we don't gate the splash on it.
    void useTodosUi.getState().hydrate();
    void usePinnedSessions.getState().hydrate();
    void useNotificationsInbox.getState().hydrate();
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

function FontGate({ children }: { children: React.ReactNode }) {
  const [fontsLoaded] = useAppFonts();
  if (!fontsLoaded) {
    // Minimal splash while custom fonts load. Uses Uniwind's `bg-bg` so
    // the active theme tints the splash if hydration finished first.
    return <View className="flex-1 bg-bg" style={styles.splash} />;
  }
  return <>{children}</>;
}

export default function RootLayout() {
  // GestureHandlerRootView is required for react-native-gesture-handler;
  // BottomSheetModalProvider is required so any descendant can ref a modal sheet.
  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <ThemeProvider>
          <FontGate>
            <QueryClientProvider client={queryClient}>
              <BottomSheetModalProvider>
                <ToastProvider>
                  <StatusBar style="auto" />
                  <AuthGate />
                </ToastProvider>
              </BottomSheetModalProvider>
            </QueryClientProvider>
          </FontGate>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  splash: {
    flex: 1,
    backgroundColor: BG,
    alignItems: "center",
    justifyContent: "center",
  },
});
