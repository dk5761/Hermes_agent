/**
 * Full-screen biometric gate. Renders on top of the entire app whenever
 * `useAppLock().locked` is true. Auto-prompts FaceID/TouchID once on mount;
 * a manual "Scanning…" pill retries if the system prompt was dismissed.
 *
 * Visual goals (mirrors the user's reference design):
 *   - "HERMES LOCKED" eyebrow
 *   - "Welcome back, <user>"
 *   - mono server status line  (URL · version)
 *   - center FaceID-style viewfinder illustration
 *   - rose/pink primary action pill
 *   - "Enter passcode" fallback link
 *   - "End-to-end encrypted · device key only" footer
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import Constants from "expo-constants";
import Svg, { Path, Circle } from "react-native-svg";

import { authenticateBiometric, useAppLock } from "../state/app-lock";
import { useAuthStore } from "../auth/store";
import { API_URL } from "../config";
import { HermesMark } from "./ui/HermesMark";
import { Icon } from "./ui/Icon";
import { Stack } from "./ui/Stack";
import { Row } from "./ui/Row";
import { Text } from "./ui/Text";
import { useThemeTokens } from "./ui/tokens";

function FaceScanArt({ tint }: { tint: string }) {
  // Rounded viewfinder corners + a tiny face. Pure SVG so it scales with
  // the layout without raster blur.
  const stroke = tint;
  return (
    <Svg width={170} height={170} viewBox="0 0 170 170">
      {/* Top-left corner */}
      <Path
        d="M30 60 V40 a10 10 0 0 1 10 -10 H60"
        stroke={stroke}
        strokeWidth={3}
        strokeLinecap="round"
        fill="none"
      />
      {/* Top-right corner */}
      <Path
        d="M110 30 H130 a10 10 0 0 1 10 10 V60"
        stroke={stroke}
        strokeWidth={3}
        strokeLinecap="round"
        fill="none"
      />
      {/* Bottom-left corner */}
      <Path
        d="M30 110 V130 a10 10 0 0 0 10 10 H60"
        stroke={stroke}
        strokeWidth={3}
        strokeLinecap="round"
        fill="none"
      />
      {/* Bottom-right corner */}
      <Path
        d="M110 140 H130 a10 10 0 0 0 10 -10 V110"
        stroke={stroke}
        strokeWidth={3}
        strokeLinecap="round"
        fill="none"
      />
      {/* Eyes */}
      <Circle cx={70} cy={75} r={2.5} fill={stroke} />
      <Circle cx={100} cy={75} r={2.5} fill={stroke} />
      {/* Smile */}
      <Path
        d="M68 95 q17 14 34 0"
        stroke={stroke}
        strokeWidth={2.6}
        strokeLinecap="round"
        fill="none"
      />
    </Svg>
  );
}

function shortHost(url: string): string {
  try {
    const u = new URL(url);
    return u.host;
  } catch {
    return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  }
}

export function AppLockOverlay() {
  const tokens = useThemeTokens();
  const locked = useAppLock((s) => s.locked);
  const available = useAppLock((s) => s.available);
  const unlock = useAppLock((s) => s.unlock);
  const username = useAuthStore((s) => s.user?.username) ?? "there";
  const version = Constants.expoConfig?.version ?? "0.0.0";
  const host = useMemo(() => shortHost(API_URL), []);
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
    if (available) void tryUnlock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked, available]);

  if (!locked) return null;

  // All colors flow from the active theme tokens so the lock screen matches
  // light/dark + the user's chosen palette (paper / graphite / plot). Pill
  // text uses `tokens.surface` because that's the always-contrasting
  // "background-of-cards" tone — light on dark themes, dark on light ones.
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
        justifyContent: "space-between",
        paddingTop: 64,
        paddingBottom: 36,
        zIndex: 1000,
        elevation: 1000,
      }}
    >
      {/* Header */}
      <Stack gap={14} style={{ alignItems: "center", paddingHorizontal: 32 }}>
        <Row gap={8} align="center">
          <HermesMark size={20} />
          <Text
            kind="caption"
            color={tokens.ink3}
            mono
            style={{ letterSpacing: 2, fontWeight: "600" }}
          >
            HERMES LOCKED
          </Text>
        </Row>
        <Stack gap={2} style={{ alignItems: "center" }}>
          <Text
            kind="h2"
            color={tokens.ink}
            style={{ textAlign: "center", fontWeight: "600" }}
          >
            Welcome back,
          </Text>
          <Text
            kind="h2"
            mono
            color={tokens.ink}
            style={{ textAlign: "center", fontWeight: "500" }}
          >
            {username}
          </Text>
        </Stack>
        <Row gap={6} align="center">
          <View
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: tokens.positive,
            }}
          />
          <Text kind="caption" mono color={tokens.ink3}>
            {host} · v{version}
          </Text>
        </Row>
      </Stack>

      {/* Center scan */}
      <Stack gap={20} style={{ alignItems: "center", paddingHorizontal: 32 }}>
        <FaceScanArt tint={tokens.accent} />
        <Stack gap={8} style={{ alignItems: "center", maxWidth: 320 }}>
          <Text kind="h3" color={tokens.ink}>
            {busy ? "Scanning…" : available ? "Looking…" : "Locked"}
          </Text>
          <Text
            kind="body"
            color={tokens.ink3}
            style={{ textAlign: "center", lineHeight: 20 }}
          >
            Your gateway key stays on-device. Hermes never sends it to a
            server.
          </Text>
        </Stack>
      </Stack>

      {/* Footer actions */}
      <Stack gap={14} style={{ alignSelf: "stretch", paddingHorizontal: 24 }}>
        {available ? (
          <Pressable
            onPress={() => void tryUnlock()}
            disabled={busy}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              paddingVertical: 16,
              borderRadius: 999,
              backgroundColor: tokens.accent,
              opacity: pressed || busy ? 0.7 : 1,
            })}
          >
            <Icon name="shield" size={18} color={tokens.surface} />
            <Text
              kind="body-lg"
              color={tokens.surface}
              style={{ fontWeight: "700" }}
            >
              {busy ? "Scanning…" : "Scan to unlock"}
            </Text>
          </Pressable>
        ) : (
          // Biometrics unavailable — simulator preview path or device that
          // lost its enrollment. Plain "Close" so the user doesn't get
          // trapped.
          <Pressable
            onPress={unlock}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              paddingVertical: 16,
              borderRadius: 999,
              backgroundColor: tokens.accent,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Icon name="close" size={18} color={tokens.surface} />
            <Text
              kind="body-lg"
              color={tokens.surface}
              style={{ fontWeight: "700" }}
            >
              Close (no biometric)
            </Text>
          </Pressable>
        )}

        {available ? (
          <Pressable
            onPress={() => void tryUnlock()}
            disabled={busy}
            hitSlop={6}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              paddingVertical: 4,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Icon name="key" size={14} color={tokens.ink2} />
            <Text kind="body" color={tokens.ink2} style={{ fontWeight: "500" }}>
              Enter passcode
            </Text>
          </Pressable>
        ) : null}

        <Row gap={6} align="center" justify="center" style={{ marginTop: 4 }}>
          <Icon name="shieldCheck" size={11} color={tokens.ink3} />
          <Text kind="caption" color={tokens.ink3}>
            End-to-end encrypted · device key only
          </Text>
        </Row>
      </Stack>
    </View>
  );
}
