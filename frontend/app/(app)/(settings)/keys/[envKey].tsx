/**
 * Provider key editor — `(app)/(settings)/keys/[envKey]`.
 *
 * Source: design/screens-3.jsx::KeyEditor (lines 215-260).
 *
 * Edits a single provider's API key on the gateway. The current value is
 * never returned from the backend; we only know whether one is `set`. Save
 * triggers PUT, Clear triggers DELETE (with a confirm step). Test is
 * deferred until the backend ships a /test endpoint.
 */
import { useEffect, useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Field,
  Input,
  NavBar,
  PhoneSafeArea,
  Row,
  showToast,
  Stack,
  StatusPill,
  Text,
} from "@/components/ui";
import {
  deleteProviderKey,
  getProviderKey,
  setProviderKey,
  type ProviderKeyDetail,
} from "@/api/keys";
import { ApiError } from "@/api/types";

function decodeParam(value: string | string[] | undefined): string | null {
  if (!value) return null;
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export default function KeyEditorScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ envKey: string | string[] }>();
  const envKey = decodeParam(params.envKey);
  const qc = useQueryClient();

  const detailQ = useQuery({
    queryKey: ["settings", "keys", envKey] as const,
    queryFn: () => {
      if (!envKey) throw new Error("missing envKey");
      return getProviderKey(envKey);
    },
    enabled: !!envKey,
  });

  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  // Reset the editor when navigation lands on a different key.
  useEffect(() => {
    setValue("");
    setReveal(false);
    setErrorText(null);
  }, [envKey]);

  // Inline error UI handles failures — `meta.silent` avoids a duplicate toast.
  const saveMut = useMutation({
    mutationFn: async (next: string) => {
      if (!envKey) throw new Error("missing envKey");
      return setProviderKey(envKey, next);
    },
    onSuccess: (data: ProviderKeyDetail) => {
      qc.setQueryData(["settings", "keys", envKey], data);
      qc.invalidateQueries({ queryKey: ["settings", "keys"] });
      showToast(`${data.label ?? envKey ?? "Key"} saved`, "success");
      router.back();
    },
    onError: (err: unknown) => {
      setErrorText(extractErrorMessage(err));
    },
    meta: { silent: true },
  });

  const deleteMut = useMutation({
    mutationFn: async () => {
      if (!envKey) throw new Error("missing envKey");
      await deleteProviderKey(envKey);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings", "keys"] });
      qc.invalidateQueries({ queryKey: ["settings", "keys", envKey] });
      showToast(`${envKey ?? "Key"} cleared`, "success");
      router.back();
    },
    onError: (err: unknown) => {
      setErrorText(extractErrorMessage(err));
    },
    meta: { silent: true },
  });

  const onSave = () => {
    setErrorText(null);
    const trimmed = value.trim();
    if (!trimmed) {
      setErrorText("Paste a key value before saving.");
      return;
    }
    // Quick sanity: API keys are always single-token strings. Embedded
    // whitespace usually means the user copied the surrounding quotes too.
    if (/\s/.test(trimmed)) {
      setErrorText("Key contains whitespace — paste only the token.");
      return;
    }
    if (trimmed.length < 8) {
      setErrorText("Key looks too short. Double-check it copied fully.");
      return;
    }
    saveMut.mutate(trimmed);
  };

  const onClear = () => {
    setErrorText(null);
    Alert.alert(
      "Clear this key?",
      "The gateway will fall back to the host environment variable (if any) until a new value is saved.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear",
          style: "destructive",
          onPress: () => deleteMut.mutate(),
        },
      ],
    );
  };

  const detail = detailQ.data;
  const title = detail?.label ?? envKey ?? "API key";
  const isSet = detail?.status === "set";

  return (
    <PhoneSafeArea>
      <NavBar title={title} onBack={() => router.back()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 60 }}>
        <Stack gap={20} style={{ paddingVertical: 12 }}>
          {/* Hero — provider summary + status pill. */}
          <View
            className="bg-surface border border-line"
            style={{ marginHorizontal: 16, padding: 16, borderRadius: 14 }}
          >
            <Stack gap={8}>
              <Text kind="h2">{detail?.label ?? "Loading…"}</Text>
              <Row gap={8} align="center" justify="space-between">
                <Text kind="caption" mono className="text-ink-3">
                  {envKey ?? ""}
                </Text>
                <StatusPill
                  kind={isSet ? "online" : "paused"}
                  label={isSet ? "set" : "unset"}
                />
              </Row>
            </Stack>
          </View>

          {/* API key input. */}
          <Stack gap={12} style={{ paddingHorizontal: 16 }}>
            <Field
              label="API key"
              hint="Paste the new value. Saving overwrites the existing key on the gateway."
              error={errorText ?? undefined}
            >
              <Input
                value={value}
                onChange={(t) => {
                  setValue(t);
                  if (errorText) setErrorText(null);
                }}
                mono
                icon="key"
                placeholder={isSet ? "Replace existing key" : "Paste new key here"}
                secureTextEntry={!reveal}
                right={
                  <Button
                    kind="ghost"
                    size="sm"
                    leftIcon={reveal ? "eyeOff" : "eye"}
                    onClick={() => setReveal((r) => !r)}
                  >
                    {""}
                  </Button>
                }
              />
            </Field>

            <Row gap={8}>
              {/* Test button is deferred — backend endpoint not yet available. */}
              <Button
                kind="secondary"
                full
                leftIcon="bolt"
                disabled
                onClick={() => {}}
              >
                Test
              </Button>
              <Button
                kind="accent"
                full
                leftIcon="check"
                disabled={saveMut.isPending || !value.trim()}
                onClick={onSave}
              >
                {saveMut.isPending ? "Saving…" : "Save"}
              </Button>
            </Row>
            {isSet ? (
              <Button
                kind="danger"
                full
                leftIcon="trash"
                disabled={deleteMut.isPending}
                onClick={onClear}
              >
                {deleteMut.isPending ? "Clearing…" : "Clear"}
              </Button>
            ) : null}
            <Text kind="caption" className="text-ink-3">
              Test endpoint coming in Phase 8. Stored on the gateway in
              ~/.hermes/.env.
            </Text>
          </Stack>
        </Stack>
      </ScrollView>
    </PhoneSafeArea>
  );
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (typeof err.body === "string") return err.body;
    if (err.body && typeof err.body === "object") {
      return err.body.error || `Request failed (${err.status})`;
    }
    return `Request failed (${err.status})`;
  }
  if (err instanceof Error) return err.message;
  return "Unknown error";
}
