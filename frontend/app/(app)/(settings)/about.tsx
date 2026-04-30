/**
 * About — Stage 4.
 *
 * Mirrors design/screens-3.jsx::AboutScreen (lines 551-581).
 *  - HermesMark + wordmark + version line at top
 *  - Versions ListGroup (app, hermes core, gateway, commit)
 *  - Static footer rows (Open source / Privacy / Terms / Reset onboarding)
 *
 * "Acknowledgements / Privacy / Terms / Reset onboarding" rows are
 * placeholders for now (see report §"punted").
 */
import { useMemo } from "react";
import { ScrollView } from "react-native";
import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";

import {
  HermesMark,
  ListGroup,
  ListRow,
  NavBar,
  PhoneSafeArea,
  Stack,
  Text,
} from "@/components/ui";
import { API_URL } from "@/config";
import { getServerStatus } from "@/api/settings";

function hostFromUrl(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

export default function AboutScreen() {
  const router = useRouter();

  const version = Constants.expoConfig?.version ?? "0.0.0";
  // expo-constants exposes nativeBuildVersion / iosBuildNumber / etc, but
  // in JS-only the canonical "build number" is `expoConfig.runtimeVersion`
  // or `extra.eas.build.number`. Fall back to `version`.
  const buildNumber = useMemo(() => {
    const cfg = Constants.expoConfig;
    return (
      cfg?.runtimeVersion?.toString() ??
      (cfg?.ios as unknown as { buildNumber?: string } | undefined)?.buildNumber ??
      (cfg?.android as unknown as { versionCode?: number } | undefined)?.versionCode?.toString() ??
      "—"
    );
  }, []);

  const statusQ = useQuery({
    queryKey: ["api", "status"],
    queryFn: getServerStatus,
    retry: false,
    staleTime: 60_000,
  });

  const hermesVersion = statusQ.data?.hermesVersion ?? "—";
  const gatewayVersion = statusQ.data?.gatewayVersion ?? "—";
  const commit = (statusQ.data?.commit as string | undefined) ?? "—";

  return (
    <PhoneSafeArea>
      <NavBar title="About" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 60 }}>
        <Stack gap={24} style={{ padding: 16 }}>
          <Stack gap={14} align="center" style={{ paddingVertical: 8 }}>
            <HermesMark size={48} />
            <Stack gap={4} align="center">
              <Text kind="h1">Hermes</Text>
              <Text kind="caption" mono className="text-ink-3">
                mobile · {version} ({buildNumber})
              </Text>
            </Stack>
          </Stack>
        </Stack>

        <Stack gap={20}>
          <ListGroup header="Versions">
            <ListRow icon="bolt" title="App" detail={`${version} · build ${buildNumber}`} />
            <ListRow icon="terminal" title="Hermes core" detail={hermesVersion} />
            <ListRow icon="globe" title="Gateway" detail={gatewayVersion} />
            <ListRow icon="hash" title="Server" detail={hostFromUrl(API_URL)} />
            {commit !== "—" ? (
              <ListRow icon="hash" title="Commit" detail={commit} />
            ) : null}
          </ListGroup>

          <ListGroup>
            <ListRow icon="doc" title="Open source" chevron />
            <ListRow icon="shieldCheck" title="Privacy" chevron />
            <ListRow icon="doc" title="Terms" chevron />
          </ListGroup>
        </Stack>
      </ScrollView>
    </PhoneSafeArea>
  );
}
