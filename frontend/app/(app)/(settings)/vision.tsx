import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Screen } from "@/components/Screen";
import { Button } from "@/components/Button";
import { ACCENT, MUTED, TEXT } from "@/config";
import {
  getSuggestedVisionModels,
  getVisionConfig,
  getVisionProviders,
  updateVisionConfig,
  type VisionProvider,
} from "@/api/settings";

export default function VisionSettingsScreen() {
  const router = useRouter();
  const qc = useQueryClient();

  const providersQ = useQuery({ queryKey: ["settings", "vision-providers"], queryFn: getVisionProviders });
  const configQ = useQuery({ queryKey: ["settings", "vision"], queryFn: getVisionConfig });

  const [provider, setProvider] = useState<string>("auto");
  const [model, setModel] = useState<string>("");
  const [baseUrl, setBaseUrl] = useState<string>("");
  const [apiKey, setApiKey] = useState<string>("");
  const [pristine, setPristine] = useState(true);

  // Hydrate form once on first config load.
  useEffect(() => {
    if (!configQ.data || !pristine) return;
    setProvider(configQ.data.provider || "auto");
    setModel(configQ.data.model || "");
    setBaseUrl(configQ.data.baseUrl || "");
    setApiKey(configQ.data.apiKey || "");
  }, [configQ.data, pristine]);

  const suggestedQ = useQuery({
    queryKey: ["settings", "vision-suggestions", provider],
    queryFn: () => getSuggestedVisionModels(provider),
    enabled: !!provider,
  });

  const selectedProvider = useMemo<VisionProvider | undefined>(
    () => providersQ.data?.find((p) => p.id === provider),
    [providersQ.data, provider],
  );

  const save = useMutation({
    mutationFn: () =>
      updateVisionConfig({
        provider,
        model: model.trim(),
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        timeoutS: configQ.data?.timeoutS ?? 120,
      }),
    onSuccess: (data) => {
      qc.setQueryData(["settings", "vision"], data);
      setApiKey(data.apiKey);
      setPristine(true);
      router.back();
    },
  });

  const onChangeProvider = (id: string) => {
    if (id === provider) return;
    setProvider(id);
    setModel("");
    setBaseUrl("");
    setPristine(false);
  };

  if (configQ.isLoading || providersQ.isLoading) {
    return (
      <Screen>
        <View style={styles.loading}>
          <ActivityIndicator color={ACCENT} />
        </View>
      </Screen>
    );
  }

  if (configQ.isError) {
    return (
      <Screen>
        <View style={styles.body}>
          <Text style={styles.errText}>
            {(configQ.error as Error)?.message ?? "Failed to load vision settings"}
          </Text>
          <Button label="Retry" onPress={() => configQ.refetch()} />
        </View>
      </Screen>
    );
  }

  const providers = providersQ.data ?? [];
  const suggestions = suggestedQ.data ?? [];
  const showBaseUrl = !!selectedProvider?.needsBaseUrl;
  const envKey = selectedProvider?.envKey;

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <View style={styles.section}>
          <Text style={styles.label}>Aux vision provider</Text>
          <Text style={styles.hint}>
            Used when your main model is text-only. Hermes runs the image through this model to extract a
            description, then feeds the text to the main model.
          </Text>
          <View style={styles.providerList}>
            {providers.map((p) => (
              <Pressable
                key={p.id}
                onPress={() => onChangeProvider(p.id)}
                style={[styles.providerRow, provider === p.id && styles.providerRowActive]}
              >
                <View style={styles.providerRowText}>
                  <Text style={styles.providerLabel}>{p.label}</Text>
                  {p.hint ? <Text style={styles.providerHint}>{p.hint}</Text> : null}
                </View>
                <View
                  style={[styles.radio, provider === p.id && styles.radioActive]}
                  pointerEvents="none"
                />
              </Pressable>
            ))}
          </View>
        </View>

        {provider !== "auto" ? (
          <View style={styles.section}>
            <Text style={styles.label}>Model</Text>
            <TextInput
              style={styles.input}
              value={model}
              onChangeText={(t) => {
                setModel(t);
                setPristine(false);
              }}
              placeholder="e.g. anthropic/claude-sonnet-4-5"
              placeholderTextColor={MUTED}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {suggestions.length > 0 ? (
              <View style={styles.chips}>
                {suggestions.map((s) => (
                  <Pressable
                    key={s}
                    onPress={() => {
                      setModel(s);
                      setPristine(false);
                    }}
                    style={[styles.chip, model === s && styles.chipActive]}
                  >
                    <Text style={[styles.chipText, model === s && styles.chipTextActive]}>{s}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>
        ) : null}

        {showBaseUrl ? (
          <View style={styles.section}>
            <Text style={styles.label}>Base URL</Text>
            <TextInput
              style={styles.input}
              value={baseUrl}
              onChangeText={(t) => {
                setBaseUrl(t);
                setPristine(false);
              }}
              placeholder="http://host.docker.internal:8000/v1"
              placeholderTextColor={MUTED}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={styles.hint}>
              For local servers, use host.docker.internal (not 127.0.0.1) so Hermes-in-Docker can reach
              your Mac.
            </Text>
          </View>
        ) : null}

        {provider !== "auto" ? (
          <View style={styles.section}>
            <Text style={styles.label}>API key (optional)</Text>
            <TextInput
              style={styles.input}
              value={apiKey}
              onChangeText={(t) => {
                setApiKey(t);
                setPristine(false);
              }}
              placeholder={envKey ? `Leave blank to use $${envKey}` : "Optional"}
              placeholderTextColor={MUTED}
              secureTextEntry={apiKey !== "***"}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {apiKey === "***" ? (
              <Text style={styles.hint}>A key is set on the server. Leave as *** to keep it.</Text>
            ) : null}
          </View>
        ) : null}

        {save.isError ? (
          <Text style={styles.errText}>{(save.error as Error).message}</Text>
        ) : null}

        <View style={styles.actions}>
          <Button label="Cancel" variant="ghost" onPress={() => router.back()} />
          <Button
            label={save.isPending ? "Saving…" : "Save"}
            onPress={() => save.mutate()}
            disabled={save.isPending || pristine}
          />
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { paddingVertical: 16, gap: 24 },
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  section: { gap: 8 },
  label: {
    color: MUTED,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  hint: { color: MUTED, fontSize: 12, lineHeight: 16 },
  input: {
    backgroundColor: "#11151B",
    color: TEXT,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    borderWidth: 1,
    borderColor: "#1E242C",
  },
  providerList: { gap: 4, marginTop: 4 },
  providerRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#0C1015",
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
    gap: 12,
    borderWidth: 1,
    borderColor: "transparent",
  },
  providerRowActive: { borderColor: ACCENT, backgroundColor: "#101824" },
  providerRowText: { flex: 1 },
  providerLabel: { color: TEXT, fontSize: 15 },
  providerHint: { color: MUTED, fontSize: 11, marginTop: 2 },
  radio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: MUTED,
  },
  radioActive: { borderColor: ACCENT, backgroundColor: ACCENT },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: "#11151B",
    borderWidth: 1,
    borderColor: "#1E242C",
  },
  chipActive: { backgroundColor: ACCENT, borderColor: ACCENT },
  chipText: { color: MUTED, fontSize: 12 },
  chipTextActive: { color: "#fff" },
  errText: { color: "#ff6b6b", fontSize: 13 },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 8 },
});
