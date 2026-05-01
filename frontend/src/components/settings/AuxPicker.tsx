/**
 * AuxPicker — shared picker UI for vision + non-vision auxiliary models.
 *
 * Shared between `(settings)/vision.tsx` and `(settings)/aux/[task].tsx`.
 * Mirrors design/screens-3.jsx::VisionScreen layout (lines 261-329):
 *   - Hero card ("Currently using …")
 *   - Provider radio list
 *   - Model field with chip suggestions
 *   - Conditional Base URL field (only when provider needs it / provider=custom)
 *   - Optional API key Input
 *   - Save Button (full-width, accent kind)
 *
 * Functional behavior is preserved from the legacy `vision.tsx`:
 *   - On save success, redirect via router.back()
 *   - "***" sentinel means "key already on server, leave alone"
 *   - dirty flag controls Save button enable
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  Button,
  Chip,
  Field,
  Icon,
  Input,
  ListGroup,
  ListRow,
  NavBar,
  PhoneSafeArea,
  Row,
  Section,
  showToast,
  Stack,
  Text,
  useThemeTokens,
} from "@/components/ui";
import {
  getAuxConfig,
  getAuxProviders,
  getAuxSuggestedModels,
  updateAuxConfig,
  type AuxTask,
  type VisionProvider,
} from "@/api/settings";

export interface AuxPickerProps {
  task: AuxTask;
  /** Title shown in the NavBar. */
  title: string;
}

export function AuxPicker({ task, title }: AuxPickerProps) {
  const router = useRouter();
  const qc = useQueryClient();
  const tokens = useThemeTokens();

  const providersQ = useQuery({
    queryKey: ["settings", "aux", "providers"],
    queryFn: getAuxProviders,
  });
  const configQ = useQuery({
    queryKey: ["settings", "aux", task],
    queryFn: () => getAuxConfig(task),
  });

  const [provider, setProvider] = useState<string>("auto");
  const [model, setModel] = useState<string>("");
  const [baseUrl, setBaseUrl] = useState<string>("");
  const [apiKey, setApiKey] = useState<string>("");
  // dirty flag: hydrate-from-server doesn't dirty the form, user edits do.
  const [dirty, setDirty] = useState(false);

  // Hydrate form once on first config load.
  useEffect(() => {
    if (!configQ.data || dirty) return;
    setProvider(configQ.data.provider || "auto");
    setModel(configQ.data.model || "");
    setBaseUrl(configQ.data.baseUrl || "");
    setApiKey(configQ.data.apiKey || "");
  }, [configQ.data, dirty]);

  const suggestedQ = useQuery({
    queryKey: ["settings", "aux", task, "suggested", provider],
    queryFn: () => getAuxSuggestedModels(task, provider),
    enabled: provider !== "auto",
  });

  const selectedProvider = useMemo<VisionProvider | undefined>(
    () => providersQ.data?.find((p) => p.id === provider),
    [providersQ.data, provider],
  );

  const save = useMutation({
    mutationFn: () =>
      updateAuxConfig(task, {
        provider,
        model: model.trim(),
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        timeoutS: configQ.data?.timeoutS ?? 120,
      }),
    onSuccess: (data) => {
      qc.setQueryData(["settings", "aux", task], data);
      // also update vision-aliased query for the index when relevant
      if (task === "vision") {
        qc.setQueryData(["settings", "vision"], data);
      }
      setApiKey(data.apiKey);
      setDirty(false);
      showToast(`${title} saved`, "success");
      router.back();
    },
  });

  const onChangeProvider = useCallback(
    (id: string) => {
      if (id === provider) return;
      setProvider(id);
      setModel("");
      setBaseUrl("");
      setDirty(true);
    },
    [provider],
  );

  const onChangeModel = useCallback((next: string) => {
    setModel(next);
    setDirty(true);
  }, []);

  const onChangeBaseUrl = useCallback((next: string) => {
    setBaseUrl(next);
    setDirty(true);
  }, []);

  const onChangeApiKey = useCallback((next: string) => {
    setApiKey(next);
    setDirty(true);
  }, []);

  const providers = providersQ.data ?? [];
  const suggestions = suggestedQ.data ?? [];
  const showBaseUrl = provider === "custom" || !!selectedProvider?.needsBaseUrl;
  const envKey = selectedProvider?.envKey;
  const isLoading = configQ.isLoading || providersQ.isLoading;

  const heroLabel =
    provider === "auto" ? "Currently using auto" : `Currently using ${provider}`;
  const heroBody =
    provider === "auto"
      ? "Hermes picks the cheapest capable model with a configured key. Override here."
      : model
        ? `${provider} · ${model}`
        : `${provider}`;

  return (
    <PhoneSafeArea>
      <NavBar
        title={title}
        onBack={() => router.back()}
        trailing={
          <Pressable
            onPress={() => save.mutate()}
            disabled={save.isPending || !dirty}
            style={{
              paddingHorizontal: 6,
              paddingVertical: 4,
              opacity: save.isPending || !dirty ? 0.4 : 1,
            }}
          >
            <Text
              kind="label"
              color={tokens.accent}
              style={{ fontWeight: "600" }}
            >
              {save.isPending ? "Saving…" : "Save"}
            </Text>
          </Pressable>
        }
      />
      <ScrollView
        contentContainerStyle={{ paddingBottom: 80 }}
        keyboardShouldPersistTaps="handled"
      >
        <Stack gap={18} style={{ paddingTop: 12 }}>
          {/* Hero card */}
          <View
            style={{
              marginHorizontal: 16,
              padding: 14,
              borderRadius: 12,
              backgroundColor: tokens.accentBg,
              borderWidth: 1,
              borderColor: tokens.accent + "33",
            }}
          >
            <Row gap={10} align="flex-start">
              <Icon name="spark" size={16} color={tokens.accent} />
              <Stack gap={3} style={{ flex: 1 }}>
                <Text kind="label" color={tokens.accent}>
                  {heroLabel}
                </Text>
                <Text kind="caption" color={tokens.ink2}>
                  {heroBody}
                </Text>
              </Stack>
            </Row>
          </View>

          <Section title="Provider">
            {isLoading ? (
              <Text kind="caption" className="text-ink-3" style={{ paddingHorizontal: 16 }}>
                Loading…
              </Text>
            ) : (
              <ListGroup>
                {providers.map((p) => {
                  const active = provider === p.id;
                  return (
                    <ListRow
                      key={p.id}
                      title={p.label}
                      subtitle={p.hint}
                      onPress={() => onChangeProvider(p.id)}
                      right={
                        <View
                          style={{
                            width: 18,
                            height: 18,
                            borderRadius: 9,
                            borderWidth: 1.5,
                            borderColor: active ? tokens.accent : tokens.line,
                            alignItems: "center",
                            justifyContent: "center",
                            marginRight: 4,
                          }}
                        >
                          {active ? (
                            <View
                              style={{
                                width: 8,
                                height: 8,
                                borderRadius: 4,
                                backgroundColor: tokens.accent,
                              }}
                            />
                          ) : null}
                        </View>
                      }
                    />
                  );
                })}
              </ListGroup>
            )}
          </Section>

          {provider !== "auto" ? (
            <Section title="Model">
              <Stack gap={10} style={{ paddingHorizontal: 16 }}>
                <Field label="Model name">
                  <Input value={model} onChange={onChangeModel} mono />
                </Field>
                {suggestions.length > 0 ? (
                  <Row gap={6} style={{ flexWrap: "wrap" }}>
                    {suggestions.map((s) => (
                      <Chip
                        key={s}
                        active={model === s}
                        onPress={() => onChangeModel(s)}
                      >
                        {s}
                      </Chip>
                    ))}
                  </Row>
                ) : null}
              </Stack>
            </Section>
          ) : null}

          {showBaseUrl ? (
            <Section title="Custom endpoint">
              <Stack gap={10} style={{ paddingHorizontal: 16 }}>
                <Field
                  label="Base URL"
                  hint="For local servers, use host.docker.internal so Hermes-in-Docker can reach your Mac."
                >
                  <Input
                    value={baseUrl}
                    onChange={onChangeBaseUrl}
                    mono
                    placeholder="https://api.example.com/v1"
                  />
                </Field>
              </Stack>
            </Section>
          ) : null}

          {provider !== "auto" ? (
            <Section title="API key (optional)">
              <Stack gap={10} style={{ paddingHorizontal: 16 }}>
                <Field
                  label="API key"
                  hint={
                    apiKey === "***"
                      ? "A key is set on the server. Leave as *** to keep it."
                      : envKey
                        ? `Falls back to $${envKey} on the host if unset.`
                        : "Optional"
                  }
                >
                  <Input
                    value={apiKey}
                    onChange={onChangeApiKey}
                    mono
                    icon="key"
                    placeholder={envKey ? `Leave blank to use $${envKey}` : "sk-…"}
                    secureTextEntry={apiKey !== "***"}
                  />
                </Field>
              </Stack>
            </Section>
          ) : null}

          {save.isError ? (
            <Text
              kind="caption"
              className="text-danger"
              style={{ paddingHorizontal: 16 }}
            >
              {(save.error as Error).message}
            </Text>
          ) : null}

          <Stack gap={8} style={{ paddingHorizontal: 16, paddingTop: 4 }}>
            <Button
              kind="accent"
              full
              onPress={() => save.mutate()}
              disabled={save.isPending || !dirty}
            >
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </Stack>
        </Stack>
      </ScrollView>
    </PhoneSafeArea>
  );
}
