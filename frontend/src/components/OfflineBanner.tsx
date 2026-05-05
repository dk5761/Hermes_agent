/**
 * OfflineBanner — thin status strip rendered just below the NavBar on tab
 * roots (chats, cron, settings). Reads the network-status singleton and the
 * pending-mutations queue to decide which of four states to paint:
 *
 *   - hidden:  online + no failed mutations → render nothing
 *   - failed:  any mutations have hit the retry cap → destructive banner,
 *              tappable, deep-links to the Diagnostics screen. Wins over
 *              every other state.
 *   - offline: online flag has been false for ≥1s → sunken "Offline" strip.
 *              The 1s debounce avoids painting the banner during a brief
 *              network blip.
 *   - synced:  offline → online transition that lasted ≥1s → 1.5s "Back
 *              online · syncing" celebration before fading back to hidden.
 *
 * The visible state is held locally; the underlying network-status flips
 * trigger transitions through timers held in refs. All timers are cleared
 * on unmount so a fast tab switch doesn't strand them.
 */
import { useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { useRouter } from "expo-router";

import { useNetworkStatus } from "@/state/network-status";
import { usePendingMutations } from "@/state/pending-mutations";
import { Icon, Row, Text, useThemeTokens } from "./ui";

type BannerKind = "hidden" | "offline" | "synced" | "failed";

const OFFLINE_DEBOUNCE_MS = 1000;
const SYNCED_HOLD_MS = 1500;

export function OfflineBanner() {
  const tokens = useThemeTokens();
  const router = useRouter();
  const online = useNetworkStatus((s) => s.online);
  const failedCount = usePendingMutations((s) =>
    s.queue.reduce((n, e) => n + (e.failed ? 1 : 0), 0),
  );

  const [kind, setKind] = useState<BannerKind>("hidden");
  const offlineTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks the previous online state so we know whether a transition is
  // worth celebrating. Never display "Back online" on app cold-start.
  const wasOfflineLongRef = useRef(false);

  useEffect(() => {
    // Failed mutations always win; nothing else matters until the user
    // resolves them via the Diagnostics screen.
    if (failedCount > 0) {
      if (offlineTimerRef.current) clearTimeout(offlineTimerRef.current);
      if (syncedTimerRef.current) clearTimeout(syncedTimerRef.current);
      offlineTimerRef.current = null;
      syncedTimerRef.current = null;
      setKind("failed");
      return;
    }

    if (!online) {
      if (syncedTimerRef.current) {
        clearTimeout(syncedTimerRef.current);
        syncedTimerRef.current = null;
      }
      // Debounce the offline banner — flicker-free for sub-second blips.
      if (!offlineTimerRef.current) {
        offlineTimerRef.current = setTimeout(() => {
          offlineTimerRef.current = null;
          wasOfflineLongRef.current = true;
          setKind("offline");
        }, OFFLINE_DEBOUNCE_MS);
      }
      return;
    }

    // Online branch.
    if (offlineTimerRef.current) {
      clearTimeout(offlineTimerRef.current);
      offlineTimerRef.current = null;
    }
    if (wasOfflineLongRef.current) {
      wasOfflineLongRef.current = false;
      setKind("synced");
      if (syncedTimerRef.current) clearTimeout(syncedTimerRef.current);
      syncedTimerRef.current = setTimeout(() => {
        syncedTimerRef.current = null;
        setKind("hidden");
      }, SYNCED_HOLD_MS);
    } else {
      setKind("hidden");
    }
  }, [online, failedCount]);

  useEffect(() => {
    return () => {
      if (offlineTimerRef.current) clearTimeout(offlineTimerRef.current);
      if (syncedTimerRef.current) clearTimeout(syncedTimerRef.current);
    };
  }, []);

  if (kind === "hidden") return null;

  if (kind === "failed") {
    return (
      <Pressable
        onPress={() => router.push("/(settings)/diagnostics" as never)}
        accessibilityRole="button"
        accessibilityLabel={`${failedCount} changes failed to sync. Tap to review.`}
        style={{
          paddingHorizontal: 12,
          paddingVertical: 6,
          backgroundColor: tokens.danger + "1F",
          borderBottomWidth: 1,
          borderBottomColor: tokens.danger + "33",
        }}
      >
        <Row gap={6} align="center">
          <Icon name="shield" size={12} color={tokens.danger} />
          <Text kind="caption" color={tokens.danger} style={{ flex: 1 }}>
            {failedCount} change{failedCount === 1 ? "" : "s"} failed to sync · tap to review
          </Text>
          <Icon name="chevR" size={12} color={tokens.danger} />
        </Row>
      </Pressable>
    );
  }

  if (kind === "offline") {
    return (
      <View
        style={{
          paddingHorizontal: 12,
          paddingVertical: 6,
          backgroundColor: tokens.sunken,
          borderBottomWidth: 1,
          borderBottomColor: tokens.lineSoft,
        }}
      >
        <Row gap={6} align="center">
          <Icon name="globe" size={12} color={tokens.ink2} />
          <Text kind="caption" color={tokens.ink2} style={{ flex: 1 }}>
            Offline · showing cached data
          </Text>
        </Row>
      </View>
    );
  }

  // synced
  return (
    <View
      style={{
        paddingHorizontal: 12,
        paddingVertical: 6,
        backgroundColor: tokens.accentBg,
        borderBottomWidth: 1,
        borderBottomColor: tokens.line,
      }}
    >
      <Row gap={6} align="center">
        <Icon name="check" size={12} color={tokens.accent} />
        <Text kind="caption" color={tokens.accent} style={{ flex: 1 }}>
          Back online · syncing
        </Text>
      </Row>
    </View>
  );
}
