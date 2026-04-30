/**
 * Per-task aux picker — `/(settings)/aux/[task]`.
 *
 * Reuses the shared <AuxPicker> from src/components/settings/AuxPicker.tsx
 * (same component the Vision screen renders). The `task` URL param decides
 * which `/settings/aux/:task` endpoint pair gets hit.
 *
 * Invalid task ids fall through to a friendly empty state — defensive in
 * case Agent A renames a slug.
 */
import { useLocalSearchParams } from "expo-router";

import { AuxPicker } from "@/components/settings/AuxPicker";
import type { AuxTask } from "@/api/settings";
import { EmptyState, NavBar, PhoneSafeArea } from "@/components/ui";
import { useRouter } from "expo-router";

const TASK_LABELS: Record<AuxTask, string> = {
  vision: "Vision",
  web_extract: "Web extract",
  compression: "Compression",
  session_search: "Session search",
  skills_hub: "Skills hub",
  approval: "Approval",
};

const VALID_TASKS = new Set<AuxTask>(
  Object.keys(TASK_LABELS) as ReadonlyArray<AuxTask>,
);

const isAuxTask = (v: string | undefined): v is AuxTask =>
  !!v && VALID_TASKS.has(v as AuxTask);

export default function AuxTaskScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ task?: string }>();
  const taskParam = Array.isArray(params.task) ? params.task[0] : params.task;

  if (!isAuxTask(taskParam)) {
    return (
      <PhoneSafeArea>
        <NavBar title="Unknown task" onBack={() => router.back()} />
        <EmptyState
          icon="close"
          title="Unknown task"
          body={`No aux task registered for "${taskParam ?? "(empty)"}".`}
        />
      </PhoneSafeArea>
    );
  }

  return <AuxPicker task={taskParam} title={TASK_LABELS[taskParam]} />;
}
