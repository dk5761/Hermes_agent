import { router } from "expo-router";

/**
 * Guarded back. Falls back to a sensible home route when there's no back
 * stack — happens on cold deep-link entry (push notification taps, app
 * launch directly into a modal) where dispatching GO_BACK throws the
 * "action 'GO_BACK' was not handled by any navigator" warning.
 */
export function safeBack(fallback: string = "/"): void {
  if (router.canGoBack()) {
    router.back();
    return;
  }
  router.replace(fallback as never);
}
