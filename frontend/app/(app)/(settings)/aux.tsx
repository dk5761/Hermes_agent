/**
 * Auxiliary models hub — list of non-vision aux tasks.
 *
 * Mirrors design/screens-3.jsx::AuxScreen (lines 330-355). Tapping a row
 * pushes /(settings)/aux/[task]. Vision lives on its own /(settings)/vision
 * route per the index hub design.
 */
import { useCallback } from "react";
import { ScrollView } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";

import {
  ListGroup,
  ListRow,
  NavBar,
  PhoneSafeArea,
  Stack,
  Text,
  useThemeTokens,
} from "@/components/ui";
import type { IconName } from "@/components/ui";
import { getAuxTasks, type AuxTask, type AuxTaskMeta } from "@/api/settings";

// Static fallback list mirroring screens-3.jsx::AuxScreen (in case the
// gateway hasn't yet shipped /settings/aux/tasks).
const FALLBACK_TASKS: ReadonlyArray<AuxTaskMeta> = [
  { id: "web_extract", label: "Web extract", description: "Used by browser & scraping tools" },
  { id: "compression", label: "Compression", description: "Compacts long contexts" },
  { id: "session_search", label: "Session search", description: "Summarizes FTS5 hits across chats" },
  { id: "skills_hub", label: "Skills hub", description: "Classifies which skill to load" },
  { id: "approval", label: "Approval", description: "Pre-judges destructive commands" },
];

const TASK_ICONS: Record<AuxTask, IconName> = {
  vision: "image",
  web_extract: "globe",
  compression: "archive",
  session_search: "search",
  skills_hub: "hash",
  approval: "shield",
};

export default function AuxHubScreen() {
  const router = useRouter();
  const tokens = useThemeTokens();

  const tasksQ = useQuery({
    queryKey: ["settings", "aux", "tasks"],
    queryFn: getAuxTasks,
    retry: false,
  });

  // Filter out "vision" — it has its own dedicated screen per the hub design.
  const tasks: ReadonlyArray<AuxTaskMeta> = (tasksQ.data && tasksQ.data.length > 0
    ? tasksQ.data
    : FALLBACK_TASKS
  ).filter((t) => t.id !== "vision");

  const onPick = useCallback(
    (task: AuxTask) => () => {
      router.push({
        pathname: "/(app)/(settings)/aux/[task]",
        params: { task },
      } as never);
    },
    [router],
  );

  return (
    <PhoneSafeArea>
      <NavBar title="Auxiliary models" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 60 }}>
        <Stack gap={12} style={{ paddingTop: 8 }}>
          <Text
            kind="caption"
            className="text-ink-3"
            style={{ paddingHorizontal: 16 }}
          >
            Override individual subsystems. Defaults to auto — leave alone unless
            you need control.
          </Text>
          <ListGroup>
            {tasks.map((t) => (
              <ListRow
                key={t.id}
                icon={TASK_ICONS[t.id] ?? "flow"}
                iconColor={tokens.chip}
                title={t.label}
                subtitle={t.description}
                detail="auto"
                chevron
                onPress={onPick(t.id)}
              />
            ))}
          </ListGroup>
        </Stack>
      </ScrollView>
    </PhoneSafeArea>
  );
}
