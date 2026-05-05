// Stage 1: Uniwind + Tailwind v4 wiring. The CSS import MUST be the very
// first import — Uniwind's metro plugin discovers themes by parsing this
// file's resolved graph at bundle time.
import "../global.css";

import { useEffect } from "react";
import { ActivityIndicator, AppState, StyleSheet, View } from "react-native";
import { Slot, useRouter } from "expo-router";
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
import { useSessionTags } from "@/state/session-tags";
import { useAppLock } from "@/state/app-lock";
import { useVoiceSettings } from "@/state/voice-settings";
import { useReasoningCollapse } from "@/state/reasoning-collapse";
import { AppLockOverlay } from "@/components/AppLockOverlay";
import { PrivacyVeil } from "@/components/PrivacyVeil";
import { reconcileOnLaunch } from "@/live-activity/bridge";
import { registerPushTokenWithBackend } from "@/notifications/register";
import { setupNotificationListeners } from "@/notifications/handler";
import { IosToolsRootSocket } from "@/ios-tools";
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
  const isAuthed = useAuthStore((s) => Boolean(s.accessToken && s.user));
  const router = useRouter();

  useEffect(() => {
    void hydrate();
    // Pin/collapse state is non-blocking — we don't gate the splash on it.
    void useTodosUi.getState().hydrate();
    void usePinnedSessions.getState().hydrate();
    void useNotificationsInbox.getState().hydrate();
    void useSessionTags.getState().hydrate();
    void useAppLock.getState().hydrate();
    void useVoiceSettings.getState().hydrate();
    void useReasoningCollapse.getState().hydrate();
    // Kill any orphan Live Activities from a previous launch — we can't
    // reliably resync their elapsed-time state across an app restart.
    void reconcileOnLaunch();
  }, [hydrate]);

  // Push token registration. Fires once auth is hydrated and the user is
  // signed in. Safe to re-fire — the underlying call short-circuits when
  // the previously-stored token equals the freshly-fetched one. Failures
  // are non-fatal (no permission, simulator, network down).
  useEffect(() => {
    if (!hydrated || !isAuthed) return;
    void registerPushTokenWithBackend().catch(() => {
      // Intentional swallow: registration failures should not block the UI
      // and the user can retry via the Notifications settings screen.
    });
  }, [hydrated, isAuthed]);

  // Notification listeners — without these, tapping a push (cron output,
  // chat_complete) does nothing. Mounted once after hydration so the cold-
  // start replay (getLastNotificationResponseAsync) fires after the router
  // is ready to accept a push().
  useEffect(() => {
    if (!hydrated) return;
    const handle = setupNotificationListeners({ router, queryClient });
    return () => handle.remove();
  }, [hydrated, router]);

  // Re-arm the app lock whenever the app leaves foreground; on return the
  // overlay auto-prompts FaceID/TouchID.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "background" || state === "inactive") {
        useAppLock.getState().rearm();
      }
    });
    return () => sub.remove();
  }, []);

  useAuthRedirect();

  if (!hydrated) {
    return (
      <View style={styles.splash}>
        <ActivityIndicator color={MUTED} />
      </View>
    );
  }
  return (
    <>
      <IosToolsRootSocket />
      <Slot />
    </>
  );
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
                  {/* Mounted last so the lock overlay paints on top of every
                      screen including pushed routes and modals. */}
                  <AppLockOverlay />
                  {/* PrivacyVeil mounts above AppLockOverlay so the App
                      Switcher snapshot is blurred even while the lock
                      screen is showing. */}
                  <PrivacyVeil />
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
