/**
 * Full-screen biometric gate. Renders on top of the entire app whenever
 * `useAppLock().locked` is true. Auto-prompts FaceID/TouchID once on mount;
 * a manual "Unlock" button retries if the user dismissed the system prompt.
 *
 * Mounted from `app/_layout.tsx` so it covers every screen including
 * pushed routes.
 */
import { useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { authenticateBiometric, useAppLock } from "../state/app-lock";
import { HermesMark } from "./ui/HermesMark";
import { Icon } from "./ui/Icon";
import { Stack } from "./ui/Stack";
import { Text } from "./ui/Text";
import { useThemeTokens } from "./ui/tokens";

export function AppLockOverlay() {
  const tokens = useThemeTokens();
  const locked = useAppLock((s) => s.locked);
  const available = useAppLock((s) => s.available);
  const unlock = useAppLock((s) => s.unlock);
  const [busy, setBusy] = useState(false);
  // Track which lock-cycle we last auto-prompted on, so re-renders don't
  // re-fire the system biometric sheet.
  const promptedFor = useRef<number>(0);
  const lockCycle = useRef<number>(0);

  useEffect(() => {
    if (locked) lockCycle.current += 1;
  }, [locked]);

  const tryUnlock = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const ok = await authenticateBiometric();
      if (ok) unlock();
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!locked) return;
    if (promptedFor.current === lockCycle.current) return;
    promptedFor.current = lockCycle.current;
    // Only auto-prompt when biometrics are actually available. Without
    // this guard the simulator preview path would silently fail and leave
    // the user staring at a lock screen with no way out.
    if (available) void tryUnlock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked, available]);

  if (!locked) return null;

  return (
    <View
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: tokens.bg,
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        elevation: 1000,
      }}
    >
      <Stack gap={20} style={{ alignItems: "center", paddingHorizontal: 32 }}>
        <HermesMark size={56} />
        <Stack gap={6} style={{ alignItems: "center" }}>
          <Text kind="h2">Locked</Text>
          <Text kind="body" color={tokens.ink3} style={{ textAlign: "center" }}>
            Unlock with FaceID, TouchID, or your device passcode to continue.
          </Text>
        </Stack>
        {available ? (
          <Pressable
            onPress={() => void tryUnlock()}
            disabled={busy}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              paddingHorizontal: 20,
              paddingVertical: 12,
              borderRadius: 12,
              backgroundColor: tokens.ink,
              opacity: pressed || busy ? 0.7 : 1,
            })}
          >
            <Icon name="key" size={16} color={tokens.surface} />
            <Text
              kind="body-lg"
              color={tokens.surface}
              style={{ fontWeight: "600" }}
            >
              {busy ? "Authenticating…" : "Unlock"}
            </Text>
          </Pressable>
        ) : (
          // Biometrics unavailable — this path is reached either by the
          // simulator-only "Preview lock screen" affordance or by
          // launching with the lock enabled on a device that lost its
          // enrolled biometrics. Offer a plain "Close" so the user
          // doesn't get trapped.
          <Pressable
            onPress={unlock}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              paddingHorizontal: 20,
              paddingVertical: 12,
              borderRadius: 12,
              backgroundColor: tokens.chip,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Icon name="close" size={16} color={tokens.ink2} />
            <Text kind="body-lg" color={tokens.ink} style={{ fontWeight: "600" }}>
              Close (no biometric)
            </Text>
          </Pressable>
        )}
      </Stack>
    </View>
  );
}
