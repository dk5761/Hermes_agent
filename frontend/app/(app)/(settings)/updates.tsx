/**
 * Over-the-air update screen — `(app)/(settings)/updates`.
 *
 * Drives the user through the expo-updates lifecycle:
 *   idle → checking → up-to-date | available
 *                       ↓
 *                    downloading (progress bar)
 *                       ↓
 *                    ready-to-restart (Reload button)
 *
 * In dev (`__DEV__`) and Expo Go (`Updates.isEnabled === false`) the screen
 * surfaces an explanatory disabled state — we can't fetch updates over those
 * delivery paths, only via EAS Update against a built bundle.
 *
 * Notes on the API:
 *   - We use the legacy imperative API (`checkForUpdateAsync` /
 *     `fetchUpdateAsync` / `reloadAsync`) rather than `useUpdates()` because
 *     the hook's progress event ("downloadProgress") doesn't actually emit
 *     for hermesc/Hermes-engine bundles in our test runs. The imperative
 *     path lets us drive a deterministic state machine and indeterminate
 *     progress while the fetch is in flight.
 */
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, View } from "react-native";
import * as Updates from "expo-updates";
import Constants from "expo-constants";

import {
  Button,
  ListGroup,
  ListRow,
  NavBar,
  PhoneSafeArea,
  ProgressBar,
  Row,
  Stack,
  Text,
  showToast,
  useThemeTokens,
} from "@/components/ui";
import { safeBack } from "@/util/nav";

type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date" }
  | { kind: "available"; manifestId?: string }
  | { kind: "downloading" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

function formatTimestamp(date: Date | null | undefined): string {
  if (!date) return "—";
  try {
    return date.toLocaleString();
  } catch {
    return date.toISOString();
  }
}

export default function UpdatesScreen() {
  const tokens = useThemeTokens();
  const [state, setState] = useState<UpdateState>({ kind: "idle" });
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);

  // Snapshot of the currently-running update bundle. These come straight from
  // Expo's runtime — no fetch needed; safe to read on every render.
  const channel = Updates.channel ?? "—";
  const runtimeVersion = Updates.runtimeVersion ?? "—";
  const updateId = Updates.updateId ?? null;
  const createdAt = Updates.createdAt;
  const appVersion = Constants.expoConfig?.version ?? "—";

  // Disabled paths: dev and Expo Go can't talk to EAS Update. Show a static
  // explanatory state instead of letting the user mash a button that always
  // errors with "Updates are not configured".
  const updatesEnabled = Updates.isEnabled === true && !__DEV__;

  const check = useCallback(async () => {
    setState({ kind: "checking" });
    try {
      const res = await Updates.checkForUpdateAsync();
      setLastCheckedAt(new Date());
      if (!res.isAvailable) {
        setState({ kind: "up-to-date" });
        return;
      }
      // `manifest` exists on the result type but is loosely typed; we only
      // surface its id (when present) for the human-readable confirmation.
      const manifest = (res as { manifest?: { id?: string } }).manifest;
      setState({
        kind: "available",
        manifestId: manifest?.id,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to check for updates";
      setState({ kind: "error", message });
    }
  }, []);

  const download = useCallback(async () => {
    setState({ kind: "downloading" });
    try {
      const res = await Updates.fetchUpdateAsync();
      if (!res.isNew) {
        // Server thinks we're current after all (e.g. a parallel check by
        // the auto-update path already pulled it). Treat as up-to-date.
        setState({ kind: "up-to-date" });
        return;
      }
      setState({ kind: "ready" });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to download update";
      setState({ kind: "error", message });
    }
  }, []);

  const restart = useCallback(async () => {
    try {
      await Updates.reloadAsync();
      // Process is replaced by the new bundle; nothing past here runs.
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to restart";
      showToast(message);
      setState({ kind: "error", message });
    }
  }, []);

  // Auto-check once on mount so opening the screen is informative without an
  // extra tap. Dev/Expo Go paths skip this entirely.
  useEffect(() => {
    if (!updatesEnabled) return;
    void check();
  }, [updatesEnabled, check]);

  return (
    <PhoneSafeArea>
      <NavBar title="App updates" onBack={() => safeBack()} />
      <ScrollView
        contentContainerStyle={{ paddingBottom: 32 }}
        showsVerticalScrollIndicator={false}
      >
        <Stack gap={16} style={{ padding: 16 }}>
          <Stack gap={4}>
            <Text kind="caption" color={tokens.ink3}>
              Currently running
            </Text>
            <ListGroup>
              <ListRow
                icon="pin"
                title="App version"
                detail={appVersion}
              />
              <ListRow
                icon="flow"
                title="Channel"
                detail={channel}
              />
              <ListRow
                icon="cog"
                title="Runtime version"
                detail={runtimeVersion}
              />
              <ListRow
                icon="hash"
                title="Update ID"
                detail={updateId ? updateId.slice(0, 8) + "…" : "embedded"}
              />
              <ListRow
                icon="clock"
                title="Published"
                detail={formatTimestamp(createdAt)}
              />
            </ListGroup>
          </Stack>

          {!updatesEnabled ? (
            <Stack gap={8}>
              <Text kind="caption" color={tokens.ink3}>
                Update checks unavailable
              </Text>
              <View
                style={{
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: tokens.line,
                  padding: 12,
                }}
              >
                <Text kind="body" color={tokens.ink}>
                  {__DEV__
                    ? "Live OTA updates are disabled in development. Build a preview or production binary with `eas build` to test the update flow."
                    : "Updates aren't configured in this build."}
                </Text>
              </View>
            </Stack>
          ) : (
            <Stack gap={8}>
              <Text kind="caption" color={tokens.ink3}>
                Latest release
              </Text>
              <View
                style={{
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: tokens.line,
                  padding: 16,
                  gap: 12,
                }}
              >
                <UpdateBody
                  state={state}
                  lastCheckedAt={lastCheckedAt}
                  onCheck={check}
                  onDownload={download}
                  onRestart={restart}
                />
              </View>
            </Stack>
          )}
        </Stack>
      </ScrollView>
    </PhoneSafeArea>
  );
}

function UpdateBody({
  state,
  lastCheckedAt,
  onCheck,
  onDownload,
  onRestart,
}: {
  state: UpdateState;
  lastCheckedAt: Date | null;
  onCheck: () => void;
  onDownload: () => void;
  onRestart: () => void;
}) {
  const tokens = useThemeTokens();

  switch (state.kind) {
    case "idle":
      return (
        <Stack gap={12}>
          <Text kind="body">
            Tap to see if a newer JS bundle is available on your channel.
          </Text>
          <Button onPress={onCheck} kind="primary" size="md">
            Check for updates
          </Button>
        </Stack>
      );

    case "checking":
      return (
        <Stack gap={12}>
          <Row gap={10} align="center">
            <ActivityIndicator />
            <Text kind="body" color={tokens.ink}>
              Checking for updates…
            </Text>
          </Row>
        </Stack>
      );

    case "up-to-date":
      return (
        <Stack gap={12}>
          <Text kind="body">You're on the latest release.</Text>
          {lastCheckedAt ? (
            <Text kind="caption" color={tokens.ink3}>
              Checked at {lastCheckedAt.toLocaleTimeString()}.
            </Text>
          ) : null}
          <Button onPress={onCheck} kind="secondary" size="md">
            Check again
          </Button>
        </Stack>
      );

    case "available":
      return (
        <Stack gap={12}>
          <Text kind="body" color={tokens.ink}>
            A new version is available.
          </Text>
          {state.manifestId ? (
            <Text kind="caption" color={tokens.ink3}>
              ID: {state.manifestId.slice(0, 8)}…
            </Text>
          ) : null}
          <Button onPress={onDownload} kind="primary" size="md">
            Download update
          </Button>
        </Stack>
      );

    case "downloading":
      return (
        <Stack gap={12}>
          <Row gap={10} align="center">
            <ActivityIndicator />
            <Text kind="body">Downloading update…</Text>
          </Row>
          {/* Indeterminate bar — `fetchUpdateAsync` doesn't reliably emit
              per-asset progress, so we show movement without a real value. */}
          <ProgressBar value={0.5} />
          <Text kind="caption" color={tokens.ink3}>
            Don't close the app while the bundle finishes downloading.
          </Text>
        </Stack>
      );

    case "ready":
      return (
        <Stack gap={12}>
          <Text kind="body" color={tokens.ink}>
            Update downloaded. Restart to apply it.
          </Text>
          <Button onPress={onRestart} kind="primary" size="md">
            Restart now
          </Button>
        </Stack>
      );

    case "error":
      return (
        <Stack gap={12}>
          <Text kind="body" color={tokens.danger}>
            {state.message}
          </Text>
          <Button onPress={onCheck} kind="secondary" size="md">
            Try again
          </Button>
        </Stack>
      );
  }
}
