// Stage 1: Uniwind + Tailwind v4 wiring. The CSS import MUST be the very
// first import — Uniwind's metro plugin discovers themes by parsing this
// file's resolved graph at bundle time.
import "../global.css";

import { useEffect } from "react";
import { ActivityIndicator, AppState, StyleSheet, View } from "react-native";
import { Slot, useRouter } from "expo-router";
import { MutationCache, QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import {
  persister,
  PERSIST_MAX_AGE,
  PERSIST_BUSTER,
  dehydrateOptions,
} from "@/cache/query-persister";
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
import { usePendingSends } from "@/state/pending-sends";
import { usePendingMutations } from "@/state/pending-mutations";
import { useNetworkStatus } from "@/state/network-status";
import { attachMutationDrainer } from "@/ws/mutation-drainer";
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

// One client per app instance. The cache is persisted to AsyncStorage by the
// PersistQueryClientProvider below — see `src/cache/query-persister.ts` for
// the dehydration filter and key versioning.
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
      retry: 2,
      staleTime: 30_000,
      // Match persist age — keeps in-memory cache alive long enough to be
      // persisted; persister hydrate then trims on its own maxAge.
      gcTime: 1000 * 60 * 60 * 24 * 7,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
      // Serve cache when offline; queries flagged paused while offline retry
      // automatically once NetInfo flips back to online.
      networkMode: "offlineFirst",
    },
    mutations: {
      networkMode: "offlineFirst",
      retry: 0,
    },
  },
});

function AuthGate() {
  const hydrated = useAuthStore((s) => s.hydrated);
  const hydrate = useAuthStore((s) => s.hydrate);
  const isAuthed = useAuthStore((s) => Boolean(s.accessToken && s.user));
  const router = useRouter();

  // NetInfo singleton — must come up before any consumer (queue drainers,
  // offline banner, retry buttons) reads `online`. See Phase 3.
  useEffect(() => useNetworkStatus.getState().init(), []);

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
    // Hydrate the offline send queue so any frames persisted across an app
    // kill / OS reboot are visible the moment the chat screen mounts. The
    // queue-drainer (attached per-chat in useChatStream) flushes them once
    // the WS reaches "open".
    void usePendingSends.getState().hydrate();
    // Pending session-level mutations (archive/rename/delete/setModel).
    // Hydrate is idempotent and does no network — safe to fire even when
    // unauthenticated. The drainer below is what gates on auth.
    void usePendingMutations.getState().hydrate();
    // Kill any orphan Live Activities from a previous launch — we can't
    // reliably resync their elapsed-time state across an app restart.
    void reconcileOnLaunch();
  }, [hydrate]);

  // Mutation drainer: replays queued session-level writes whenever the
  // user is authed AND the network is reachable. Mounted once per auth
  // session — logging out tears it down (effect cleanup) so a logged-out
  // app never retries 401-bound mutations.
  useEffect(() => {
    if (!isAuthed) return;
    return attachMutationDrainer({ queryClient });
  }, [isAuthed]);

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
            <PersistQueryClientProvider
              client={queryClient}
              persistOptions={{
                persister,
                maxAge: PERSIST_MAX_AGE,
                dehydrateOptions,
                buster: PERSIST_BUSTER,
              }}
              onSuccess={() => {
                // Resume any mutations that were paused while we were
                // rehydrating. Pending writes carried across an app restart
                // get a chance to fire before the user notices.
                void queryClient.resumePausedMutations();
              }}
            >
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
            </PersistQueryClientProvider>
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
