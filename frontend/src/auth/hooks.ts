import { useEffect } from "react";
import { useRouter, useSegments } from "expo-router";
import { useAuthStore } from "./store";
import type { AuthUser } from "../api/types";

export function useAuth(): {
  hydrated: boolean;
  isAuthenticated: boolean;
  user: AuthUser | null;
} {
  const hydrated = useAuthStore((s) => s.hydrated);
  const accessToken = useAuthStore((s) => s.accessToken);
  const user = useAuthStore((s) => s.user);
  return {
    hydrated,
    isAuthenticated: Boolean(accessToken && user),
    user,
  };
}

// Drives the auth-aware redirect: nav into (auth) when logged out, into (app)
// when logged in. Mounted once at the root layout — depends on hydration done.
export function useAuthRedirect(): void {
  const segments = useSegments();
  const router = useRouter();
  const hydrated = useAuthStore((s) => s.hydrated);
  const isAuthed = useAuthStore((s) => Boolean(s.accessToken && s.user));

  useEffect(() => {
    if (!hydrated) return;
    const inAuthGroup = segments[0] === "(auth)";
    if (!isAuthed && !inAuthGroup) {
      router.replace("/login");
    } else if (isAuthed && inAuthGroup) {
      router.replace("/");
    }
  }, [hydrated, isAuthed, segments, router]);
}
