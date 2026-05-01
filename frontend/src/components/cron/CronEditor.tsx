/**
 * CronEditor — shared form for the "New" and "Edit" cron-job routes.
 *
 * Visual target: design/screens-2.jsx::CronEditor (lines 189-258).
 *
 * Design notes:
 *   - Cron schedule is driven by 4 preset chips. Picking a preset sets the
 *     expression directly; picking "Custom" reveals a mono input the user
 *     can edit. The selected chip is derived from the current expression
 *     so navigating to /edit re-selects the matching preset automatically.
 *   - "Next 3 runs" is computed client-side via cron-parser (see
 *     util/cronPreview). Invalid expressions surface inline below the chip
 *     row instead of the preview.
 *   - Save is disabled until name + prompt are non-empty AND the schedule
 *     parses. Mutations invalidate the jobs list and (for edit) this job's
 *     detail key.
 *   - Model field is a free-form Input placeholder until the Stage 4 model
 *     picker exists. Delivery target is a SegControl mapped 1:1 with the
 *     backend's accepted values.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  Button,
  Chip,
  EmptyState,
  Field,
  Input,
  NavBar,
  PhoneSafeArea,
  Row,
  SegControl,
  Section,
  showToast,
  Stack,
  Text,
  Toggle,
  useThemeTokens,
} from "@/components/ui";
import {
  createJob,
  cronKeys,
  getJob,
  updateJob,
  setNotifyPref,
  type CronJobInput,
} from "@/api/cron";
import type { CronJob } from "@/api/types";
import { formatPreview, isValidCron, nextRuns } from "@/util/cronPreview";

export type CronEditorMode = "create" | "edit";

export interface CronEditorProps {
  mode: CronEditorMode;
  /** Required when mode === "edit". Ignored for create. */
  jobId?: string;
}

interface Preset {
  id: PresetId;
  label: string;
  expr: string;
}

type PresetId = "hourly" | "daily" | "weekdays" | "custom";

const PRESETS: ReadonlyArray<Preset> = [
  { id: "hourly", label: "Hourly", expr: "0 * * * *" },
  { id: "daily", label: "Daily", expr: "0 9 * * *" },
  { id: "weekdays", label: "Weekdays", expr: "0 9 * * 1-5" },
  { id: "custom", label: "Custom", expr: "" },
];

const DELIVER_OPTIONS = [
  { value: "origin", label: "Origin" },
  { value: "local", label: "Local" },
  { value: "telegram", label: "Telegram" },
  { value: "discord", label: "Discord" },
] as const;

type DeliverValue = (typeof DELIVER_OPTIONS)[number]["value"];

function detectPreset(expr: string): PresetId {
  const match = PRESETS.find((p) => p.id !== "custom" && p.expr === expr);
  return match ? match.id : "custom";
}

function readSchedExpr(job: CronJob): string {
  const sched = job.schedule as Record<string, unknown> | undefined;
  if (typeof sched?.expr === "string") return sched.expr;
  if (typeof sched?.expression === "string") return sched.expression as string;
  return "";
}

export function CronEditor({ mode, jobId }: CronEditorProps): React.ReactElement {
  const router = useRouter();
  const queryClient = useQueryClient();
  const tokens = useThemeTokens();

  // Editing requires loading the existing job; create skips this entirely.
  const jobQuery = useQuery({
    queryKey: cronKeys.job(jobId ?? ""),
    queryFn: () => getJob(jobId!),
    enabled: mode === "edit" && !!jobId,
  });

  const existing = mode === "edit" ? jobQuery.data : undefined;

  // Form state. Default-initialized for create; hydrated from server for edit
  // via the effect below. We don't gate render on hydration so the user sees
  // the empty form immediately, then it fills in as the query resolves.
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [schedule, setSchedule] = useState("0 9 * * *");
  const [presetId, setPresetId] = useState<PresetId>("daily");
  const [deliver, setDeliver] = useState<DeliverValue>("origin");
  const [model, setModel] = useState<string>("");
  const [notify, setNotify] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (mode !== "edit" || !existing || hydrated) return;
    setName(existing.name);
    setPrompt(existing.prompt);
    const expr = readSchedExpr(existing) || "0 9 * * *";
    setSchedule(expr);
    setPresetId(detectPreset(expr));
    const d = (existing.deliver ?? "origin") as DeliverValue;
    // Defensive: if backend ships an unexpected value, fall back to "origin"
    // so the SegControl doesn't sit in a broken state with no segment active.
    setDeliver(
      DELIVER_OPTIONS.some((o) => o.value === d) ? d : "origin",
    );
    setModel(existing.model ?? "");
    setNotify(existing.notifyOnComplete);
    setHydrated(true);
  }, [mode, existing, hydrated]);

  // Validation. We only fail the schedule on truly broken expressions —
  // empty prompt/name disable Save without surfacing a red error message
  // (matches iOS form conventions).
  const scheduleValid = isValidCron(schedule);
  const canSave =
    name.trim().length > 0 && prompt.trim().length > 0 && scheduleValid;

  const previews = useMemo(
    () => (scheduleValid ? nextRuns(schedule, 3) ?? [] : []),
    [schedule, scheduleValid],
  );

  const onPickPreset = useCallback((p: Preset) => {
    setPresetId(p.id);
    if (p.id !== "custom") setSchedule(p.expr);
  }, []);

  // Save mutation — branches on mode. We chain a separate notify-prefs PUT
  // because /cron/jobs doesn't accept the notify flag inline.
  const createMut = useMutation({
    mutationFn: async (input: CronJobInput): Promise<CronJob> => {
      const created = await createJob(input);
      if (notify) {
        try {
          await setNotifyPref(created.id, true);
        } catch {
          // Non-fatal: the job exists; the user can flip the toggle on the
          // detail screen. Surface as a soft warning rather than abort.
        }
      }
      return created;
    },
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: cronKeys.jobs() });
      showToast(`Job “${created.name}” created`, "success");
      router.replace({
        pathname: "/(cron)/[jobId]",
        params: { jobId: created.id },
      });
    },
    onError: (err) => {
      Alert.alert("Could not create job", (err as Error).message);
    },
    // Local Alert handles errors — silence the global toast.
    meta: { silent: true },
  });

  const updateMut = useMutation({
    mutationFn: async (): Promise<CronJob> => {
      if (!jobId) throw new Error("missing jobId");
      const patch = {
        name: name.trim(),
        prompt: prompt.trim(),
        schedule,
        deliver,
        model: model.trim() ? model.trim() : null,
      } as const;
      const updated = await updateJob(jobId, patch);
      if (existing && existing.notifyOnComplete !== notify) {
        try {
          await setNotifyPref(jobId, notify);
        } catch {
          // See createMut comment.
        }
      }
      return updated;
    },
    onSuccess: () => {
      if (jobId) {
        void queryClient.invalidateQueries({ queryKey: cronKeys.job(jobId) });
      }
      void queryClient.invalidateQueries({ queryKey: cronKeys.jobs() });
      showToast("Job updated", "success");
      router.back();
    },
    onError: (err) => {
      Alert.alert("Could not update job", (err as Error).message);
    },
    meta: { silent: true },
  });

  const onSave = useCallback(() => {
    if (!canSave) return;
    if (mode === "create") {
      const input: CronJobInput = {
        name: name.trim(),
        prompt: prompt.trim(),
        schedule,
        deliver,
      };
      if (model.trim()) input.model = model.trim();
      createMut.mutate(input);
    } else {
      updateMut.mutate();
    }
  }, [canSave, mode, name, prompt, schedule, deliver, model, createMut, updateMut]);

  const onCancel = useCallback(() => router.back(), [router]);

  const saving = createMut.isPending || updateMut.isPending;
  const title = mode === "edit" ? "Edit job" : "New job";

  // Edit mode: spinner-equivalent placeholder until the existing job loads.
  // We render it inside the same NavBar shell so the back button works.
  if (mode === "edit" && (!existing || jobQuery.isLoading)) {
    return (
      <PhoneSafeArea>
        <NavBar
          title={title}
          onBack={onCancel}
          trailing={
            <Button kind="ghost" size="sm" disabled>
              Save
            </Button>
          }
        />
        {jobQuery.isError ? (
          <EmptyState
            icon="close"
            title="Failed to load job"
            body={(jobQuery.error as Error | undefined)?.message}
            action={
              <Button kind="secondary" onPress={() => jobQuery.refetch()}>
                Retry
              </Button>
            }
          />
        ) : (
          <View style={{ padding: 16 }}>
            <Text kind="body" color={tokens.ink3}>
              Loading…
            </Text>
          </View>
        )}
      </PhoneSafeArea>
    );
  }

  return (
    <PhoneSafeArea>
      <NavBar
        title={title}
        leading={
          <Button kind="ghost" size="sm" onPress={onCancel}>
            Cancel
          </Button>
        }
        trailing={
          <Button
            kind="accent"
            size="sm"
            disabled={!canSave || saving}
            onPress={onSave}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        }
      />
      <ScrollView
        contentContainerStyle={{ paddingTop: 8, paddingBottom: 60 }}
        keyboardShouldPersistTaps="handled"
      >
        <Stack gap={20}>
          <Stack gap={16} style={{ paddingHorizontal: 16 }}>
            <Field label="Name">
              <Input
                value={name}
                onChange={setName}
                placeholder="Daily standup digest"
              />
            </Field>
            <Field label="Prompt" hint="What should Hermes do on each run?">
              <Input
                value={prompt}
                onChange={setPrompt}
                placeholder="Describe the task…"
                textInputProps={{
                  multiline: true,
                  numberOfLines: 6,
                  textAlignVertical: "top",
                  style: {
                    minHeight: 120,
                    paddingTop: 8,
                    paddingBottom: 8,
                  },
                }}
                style={{ height: undefined, minHeight: 120, alignItems: "flex-start", paddingVertical: 8 }}
              />
            </Field>
          </Stack>

          <Section title="Schedule">
            <Stack gap={10} style={{ paddingHorizontal: 16 }}>
              <Row gap={6} style={{ flexWrap: "wrap" }}>
                {PRESETS.map((p) => (
                  <Chip
                    key={p.id}
                    active={presetId === p.id}
                    onPress={() => onPickPreset(p)}
                  >
                    {p.label}
                  </Chip>
                ))}
              </Row>
              {presetId === "custom" ? (
                <Field
                  label="Cron expression"
                  hint="Pick a preset or enter a cron expression."
                  error={scheduleValid ? undefined : "Invalid cron expression"}
                >
                  <Input value={schedule} onChange={setSchedule} mono />
                </Field>
              ) : (
                <Text kind="caption" mono color={tokens.ink3}>
                  {schedule}
                </Text>
              )}
              <View
                style={{
                  padding: 12,
                  backgroundColor: tokens.surface,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: tokens.line,
                }}
              >
                <Text
                  kind="micro"
                  color={tokens.ink3}
                  className="uppercase"
                  style={{ marginBottom: 6 }}
                >
                  Next 3 runs
                </Text>
                {previews.length > 0 ? (
                  <Stack gap={4}>
                    {previews.map((d, i) => (
                      <Text key={i} kind="caption" mono>
                        {formatPreview(d)}
                      </Text>
                    ))}
                  </Stack>
                ) : (
                  <Text kind="caption" mono color={tokens.ink3}>
                    {scheduleValid ? "—" : "(invalid expression)"}
                  </Text>
                )}
              </View>
            </Stack>
          </Section>

          <Section title="Run config">
            <Stack gap={12} style={{ paddingHorizontal: 16 }}>
              <Field
                label="Model"
                hint="Leave empty to inherit the current main model."
              >
                <Input
                  value={model}
                  onChange={setModel}
                  placeholder="e.g. anthropic/claude-sonnet-4"
                  mono
                />
              </Field>
              <Field label="Deliver to">
                <SegControl
                  options={DELIVER_OPTIONS as unknown as ReadonlyArray<{ value: string; label: string }>}
                  value={deliver}
                  onChange={(next) => setDeliver(next as DeliverValue)}
                />
              </Field>
              <Row align="center" justify="space-between">
                <Stack gap={2} style={{ flex: 1, paddingRight: 12 }}>
                  <Text kind="body-lg" style={{ fontWeight: "500" }}>
                    Notify on completion
                  </Text>
                  <Text kind="caption" color={tokens.ink3}>
                    Push when this job finishes
                  </Text>
                </Stack>
                <Toggle on={notify} onChange={setNotify} />
              </Row>
            </Stack>
          </Section>
        </Stack>
      </ScrollView>
    </PhoneSafeArea>
  );
}
