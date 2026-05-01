/**
 * Main model picker — `/(settings)/model`.
 *
 * Mirrors design/screens-3.jsx::ModelPicker (lines 78-158):
 *   - Hero card: "Currently using" + capability badges
 *   - Search input + filter chips (Vision / Tool-calling / Reasoning)
 *   - Provider-grouped list of models
 *   - Tap → confirm sheet → PUT /settings/model
 *
 * Query keys (per spec):
 *   ["settings", "model"]
 *   ["settings", "model", "providers"]
 *   ["settings", "model", "list", provider, filter, q]
 */
import React, { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  Button,
  Chip,
  Icon,
  Input,
  NavBar,
  PhoneSafeArea,
  Row,
  Section,
  Sheet,
  showToast,
  SkeletonGroup,
  Stack,
  Text,
  type SheetHandle,
  useThemeTokens,
} from "@/components/ui";
import {
  getMainModel,
  getModelList,
  getModelProviders,
  updateMainModel,
  type ModelListEntry,
} from "@/api/settings";

interface FilterFlags {
  vision: boolean;
  tools: boolean;
  reasoning: boolean;
}

function filterToString(f: FilterFlags): string {
  const parts: string[] = [];
  if (f.vision) parts.push("vision");
  if (f.tools) parts.push("tools");
  if (f.reasoning) parts.push("reasoning");
  return parts.join(",");
}

function formatCtx(n: number | null | undefined): string {
  if (!n) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

interface ModelRowProps {
  m: ModelListEntry;
  selected: boolean;
  onPick: (m: ModelListEntry) => void;
  accent: string;
  accentBg: string;
  line: string;
  lineSoft: string;
  chip: string;
  ink2: string;
  ink3: string;
  isLast: boolean;
}

const ModelRow = React.memo(function ModelRow({
  m,
  selected,
  onPick,
  accent,
  accentBg,
  line,
  lineSoft,
  chip,
  ink2,
  ink3,
  isLast,
}: ModelRowProps) {
  const onPress = useCallback(() => onPick(m), [m, onPick]);
  const flags: string[] = [];
  if (m.supportsVision) flags.push("vision");
  if (m.supportsTools) flags.push("tools");
  if (m.supportsReasoning) flags.push("reasoning");

  return (
    <Pressable
      onPress={onPress}
      style={{
        paddingVertical: 12,
        paddingHorizontal: 14,
        borderBottomWidth: isLast ? 0 : 1,
        borderBottomColor: lineSoft,
        backgroundColor: selected ? accentBg : "transparent",
      }}
    >
      <Row gap={10} align="center">
        <View
          style={{
            width: 18,
            height: 18,
            borderRadius: 9,
            borderWidth: 1.5,
            borderColor: selected ? accent : line,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {selected ? (
            <View
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: accent,
              }}
            />
          ) : null}
        </View>
        <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
          <Text kind="body-lg" mono numberOfLines={1}>
            {m.label || m.id}
          </Text>
          <Row gap={6} align="center" style={{ flexWrap: "wrap" }}>
            <Text kind="caption" color={ink3}>
              {formatCtx(m.contextWindow)} ctx
            </Text>
            {flags.map((f) => (
              <View
                key={f}
                style={{
                  backgroundColor: chip,
                  borderRadius: 4,
                  paddingHorizontal: 6,
                  paddingVertical: 1,
                }}
              >
                <Text
                  kind="micro"
                  color={ink2}
                  style={{ fontWeight: "500" }}
                >
                  {f}
                </Text>
              </View>
            ))}
          </Row>
        </Stack>
      </Row>
    </Pressable>
  );
});

function CapBadge({ children, chip, ink2 }: { children: string; chip: string; ink2: string }) {
  return (
    <View
      style={{
        backgroundColor: chip,
        borderRadius: 4,
        paddingHorizontal: 6,
        paddingVertical: 2,
      }}
    >
      <Text kind="micro" mono color={ink2} style={{ fontWeight: "500" }}>
        {children}
      </Text>
    </View>
  );
}

export default function ModelPickerScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const tokens = useThemeTokens();

  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<FilterFlags>({
    vision: false,
    tools: false,
    reasoning: false,
  });
  const [pending, setPending] = useState<ModelListEntry | null>(null);
  const sheetRef = useRef<SheetHandle>(null);

  const currentQ = useQuery({
    queryKey: ["settings", "model"],
    queryFn: getMainModel,
  });
  const providersQ = useQuery({
    queryKey: ["settings", "model", "providers"],
    queryFn: getModelProviders,
  });

  const filterStr = filterToString(filter);
  const listQ = useQuery({
    queryKey: ["settings", "model", "list", undefined, filterStr, q],
    queryFn: () => getModelList({ filter: filterStr || undefined, q: q || undefined }),
  });

  // Inline error text in the sheet handles failures — silence the global toast
  // to avoid duplicating the same message in two places.
  const save = useMutation({
    mutationFn: (m: ModelListEntry) =>
      updateMainModel(m.provider ?? inferProvider(m, providersQ.data ?? []), m.id),
    onSuccess: (data) => {
      qc.setQueryData(["settings", "model"], data);
      sheetRef.current?.dismiss();
      setPending(null);
      showToast(`Model set to ${data.model}`, "success");
    },
    meta: { silent: true },
  });

  const onPickModel = useCallback((m: ModelListEntry) => {
    setPending(m);
    sheetRef.current?.present();
  }, []);

  const toggleVision = useCallback(
    () => setFilter((f) => ({ ...f, vision: !f.vision })),
    [],
  );
  const toggleTools = useCallback(
    () => setFilter((f) => ({ ...f, tools: !f.tools })),
    [],
  );
  const toggleReasoning = useCallback(
    () => setFilter((f) => ({ ...f, reasoning: !f.reasoning })),
    [],
  );

  // Group the flat list by provider for rendering. Backend may already return
  // `provider` per row; if absent, fall back to the providers list lookup.
  const grouped = useMemo(() => {
    const list = listQ.data ?? [];
    const providers = providersQ.data ?? [];
    const map = new Map<string, ModelListEntry[]>();
    for (const m of list) {
      const pid = m.provider ?? inferProvider(m, providers);
      const arr = map.get(pid) ?? [];
      arr.push(m);
      map.set(pid, arr);
    }
    // Order by providers list when known, then any unknowns alpha.
    const orderedIds: string[] = [];
    for (const p of providers) if (map.has(p.id)) orderedIds.push(p.id);
    for (const id of map.keys()) if (!orderedIds.includes(id)) orderedIds.push(id);
    return orderedIds.map((id) => ({
      providerId: id,
      providerLabel:
        providers.find((p) => p.id === id)?.label ?? id,
      models: map.get(id) ?? [],
    }));
  }, [listQ.data, providersQ.data]);

  const cur = currentQ.data;
  const caps = cur?.capabilities;
  const capsList: string[] = [];
  if (caps?.supports_vision) capsList.push("vision");
  if (caps?.supports_tools) capsList.push("tools");
  if (caps?.supports_reasoning) capsList.push("reasoning");

  return (
    <PhoneSafeArea>
      <NavBar title="Main model" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 80 }}>
        <Stack gap={12} style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 }}>
          {/* Current */}
          <View
            className="bg-surface border border-line"
            style={{ padding: 14, borderRadius: 12 }}
          >
            <Row justify="space-between" align="flex-start">
              <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
                <Text kind="micro" className="text-ink-3 uppercase">
                  Currently using
                </Text>
                <Text kind="h2" numberOfLines={1}>
                  {cur?.model ?? "—"}
                </Text>
                <Text kind="caption" mono className="text-ink-3">
                  {cur?.provider ?? "—"} · {formatCtx(cur?.contextWindow ?? null)} ctx
                </Text>
              </Stack>
              <Row
                gap={4}
                style={{
                  flexWrap: "wrap",
                  justifyContent: "flex-end",
                  maxWidth: 140,
                }}
              >
                {capsList.map((c) => (
                  <CapBadge key={c} chip={tokens.chip} ink2={tokens.ink2}>
                    {c}
                  </CapBadge>
                ))}
              </Row>
            </Row>
          </View>

          <Input
            value={q}
            onChange={setQ}
            icon="search"
            placeholder="Search models or providers"
          />

          <Row gap={6}>
            <Chip active={filter.vision} onPress={toggleVision}>
              Vision
            </Chip>
            <Chip active={filter.tools} onPress={toggleTools}>
              Tool-calling
            </Chip>
            <Chip active={filter.reasoning} onPress={toggleReasoning}>
              Reasoning
            </Chip>
          </Row>
        </Stack>

        <Stack gap={18}>
          {listQ.isLoading ? (
            <SkeletonGroup count={6} />
          ) : grouped.length === 0 ? (
            <Text
              kind="caption"
              className="text-ink-3"
              style={{ paddingHorizontal: 16 }}
            >
              No models match.
            </Text>
          ) : (
            grouped.map((group) => (
              <Section key={group.providerId} title={group.providerLabel}>
                <View
                  className="bg-surface border border-line overflow-hidden"
                  style={{ marginHorizontal: 16, borderRadius: 12 }}
                >
                  {group.models.map((m, i) => (
                    <ModelRow
                      key={`${group.providerId}:${m.id}`}
                      m={{ ...m, provider: m.provider ?? group.providerId }}
                      selected={
                        cur?.model === m.id &&
                        (cur?.provider ?? group.providerId) === group.providerId
                      }
                      onPick={onPickModel}
                      accent={tokens.accent}
                      accentBg={tokens.accentBg}
                      line={tokens.line}
                      lineSoft={tokens.lineSoft}
                      chip={tokens.chip}
                      ink2={tokens.ink2}
                      ink3={tokens.ink3}
                      isLast={i === group.models.length - 1}
                    />
                  ))}
                </View>
              </Section>
            ))
          )}
        </Stack>
      </ScrollView>

      {/* Confirm sheet — standardized quick-action height. */}
      <Sheet ref={sheetRef} snapPoints={["35%"]}>
        <Stack gap={16} style={{ padding: 20 }}>
          <Stack gap={4}>
            <Text kind="h3">Switch main model?</Text>
            <Text kind="body" className="text-ink-3">
              {pending
                ? `New conversations will use ${pending.label || pending.id}. Existing chats keep their current model.`
                : ""}
            </Text>
          </Stack>
          <View
            className="bg-sunken border border-line-soft"
            style={{ borderRadius: 10, padding: 12 }}
          >
            <Text kind="body-lg" mono>
              {pending?.label || pending?.id || ""}
            </Text>
            <Text kind="caption" mono className="text-ink-3" style={{ marginTop: 2 }}>
              {pending?.provider ?? ""} · {formatCtx(pending?.contextWindow ?? null)} ctx
            </Text>
          </View>
          <Row gap={8}>
            <Button
              kind="secondary"
              full
              onPress={() => {
                sheetRef.current?.dismiss();
                setPending(null);
              }}
            >
              Cancel
            </Button>
            <Button
              kind="accent"
              full
              onPress={() => {
                if (pending) save.mutate(pending);
              }}
              disabled={save.isPending}
            >
              {save.isPending ? "Switching…" : "Confirm"}
            </Button>
          </Row>
          {save.isError ? (
            <Text kind="caption" className="text-danger">
              {(save.error as Error).message}
            </Text>
          ) : null}
        </Stack>
      </Sheet>
    </PhoneSafeArea>
  );
}

/** Best-effort fallback when ModelListEntry omits provider. */
function inferProvider(
  m: ModelListEntry,
  providers: ReadonlyArray<{ id: string; label: string }>,
): string {
  if (m.provider) return m.provider;
  // Try id prefix match like `openai:gpt-5` or `openai/gpt-5`.
  const sep = m.id.includes(":") ? ":" : m.id.includes("/") ? "/" : null;
  if (sep) {
    const prefix = m.id.split(sep)[0]!;
    if (providers.some((p) => p.id === prefix)) return prefix;
  }
  return providers[0]?.id ?? "unknown";
}
