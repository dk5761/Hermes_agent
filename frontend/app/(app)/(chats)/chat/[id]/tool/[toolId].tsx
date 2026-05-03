/**
 * Tool detail (push route) — Stage 6 satellite.
 *
 * Visual target: design_handoff_hermes/design/screens-4.jsx::ToolDetailScreen.
 *
 * Sourced from chat-store: the tool either lives in the finalized
 * `messages` array (post-`tool.complete`) or in the streaming `toolCalls`
 * map (still running). When neither is present the data was never loaded
 * into memory (cold deep-link) and we render an explanatory empty state.
 *
 * The "Approve" / "Reject" footer in the design is left as a placeholder:
 * the chat-store models approvals as a separate event kind
 * (`pendingApprovals`), not per-tool. There is currently no signal on a
 * ToolCallCard saying it is awaiting approval. This is documented as a TODO.
 */
import React from "react";
import { ScrollView, View } from "react-native";
import { Stack as ExpoStack, useLocalSearchParams } from "expo-router";
import { safeBack } from "@/util/nav";
import {
  Button,
  EmptyState,
  Icon,
  MonoBlock,
  NavBar,
  PhoneSafeArea,
  Row,
  Section,
  Stack,
  StatusPill,
  Text,
  useThemeTokens,
} from "@/components/ui";
import type { StatusPillKind } from "@/components/ui";
import { useToolFromStore } from "@/hooks/useToolFromStore";

interface DiffLineProps {
  kind: "+" | "-" | " ";
  no: number | string;
  text: string;
}

function DiffLine({ kind, no, text }: DiffLineProps) {
  const tokens = useThemeTokens();
  // Design uses ~10% alpha; "1A" hex = 26/255 ≈ 10%.
  const bg =
    kind === "+"
      ? tokens.positive + "1A"
      : kind === "-"
        ? tokens.danger + "1A"
        : "transparent";
  const symColor =
    kind === "+" ? tokens.positive : kind === "-" ? tokens.danger : tokens.ink3;
  const sym = kind === "+" ? "+" : kind === "-" ? "−" : " ";
  return (
    <View
      style={{
        flexDirection: "row",
        backgroundColor: bg,
        paddingVertical: 1,
      }}
    >
      <Text
        kind="caption"
        mono
        color={tokens.ink3}
        style={{
          width: 36,
          textAlign: "right",
          paddingRight: 8,
          lineHeight: 18,
        }}
      >
        {no}
      </Text>
      <Text
        kind="caption"
        mono
        color={symColor}
        style={{ width: 14, lineHeight: 18 }}
      >
        {sym}
      </Text>
      <Text
        kind="caption"
        mono
        color={tokens.ink2}
        style={{ flex: 1, lineHeight: 18 }}
      >
        {text}
      </Text>
    </View>
  );
}

interface InlineDiffEntry {
  kind: "+" | "-" | " ";
  line: number | string;
  text: string;
}

interface TodoEntry {
  text: string;
  done: boolean;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function pretty(v: unknown): string {
  if (v === undefined) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function parseDiff(detail: Record<string, unknown>): InlineDiffEntry[] | null {
  const raw = detail["inline_diff"] ?? detail["diff"];
  if (!raw) return null;
  if (Array.isArray(raw)) {
    const out: InlineDiffEntry[] = [];
    for (const r of raw) {
      if (!r || typeof r !== "object") continue;
      const obj = r as Record<string, unknown>;
      const k = obj["kind"];
      const text = asString(obj["text"]) ?? "";
      const line = obj["line"] ?? obj["no"] ?? "";
      const lineVal: number | string =
        typeof line === "number" || typeof line === "string" ? line : "";
      let normK: "+" | "-" | " " = " ";
      if (k === "+" || k === "add" || k === "addition") normK = "+";
      else if (k === "-" || k === "del" || k === "deletion") normK = "-";
      out.push({ kind: normK, line: lineVal, text });
    }
    return out.length ? out : null;
  }
  return null;
}

function parseTodos(detail: Record<string, unknown>): TodoEntry[] | null {
  const raw = detail["todos"];
  if (!Array.isArray(raw)) return null;
  const out: TodoEntry[] = [];
  for (const r of raw) {
    if (typeof r === "string") {
      out.push({ text: r, done: false });
    } else if (r && typeof r === "object") {
      const obj = r as Record<string, unknown>;
      const text = asString(obj["text"]) ?? asString(obj["content"]) ?? "";
      const done =
        obj["done"] === true ||
        obj["completed"] === true ||
        obj["status"] === "done" ||
        obj["status"] === "completed";
      if (text) out.push({ text, done });
    }
  }
  return out.length ? out : null;
}

function statusToPill(status: "running" | "complete" | "error"): StatusPillKind {
  if (status === "running") return "connecting";
  if (status === "error") return "offline";
  return "online";
}

function statusLabel(status: "running" | "complete" | "error"): string {
  if (status === "running") return "running";
  if (status === "error") return "error";
  return "complete";
}

export default function ToolDetailScreen() {
  const params = useLocalSearchParams<{ id: string; toolId: string }>();
  const appSessionId = typeof params.id === "string" ? params.id : null;
  const toolId = typeof params.toolId === "string" ? params.toolId : null;
  const tokens = useThemeTokens();

  const lookup = useToolFromStore(appSessionId, toolId);

  if (!lookup) {
    return (
      <PhoneSafeArea>
        <ExpoStack.Screen options={{ headerShown: false }} />
        <NavBar title="Tool" onBack={() => safeBack(appSessionId ? `/chat/${appSessionId}` : "/")} />
        <EmptyState
          icon="terminal"
          title="Tool details unavailable"
          body="Tool details are only available during an active session. Open the chat to load history."
          action={
            <Button kind="secondary" onPress={() => safeBack(appSessionId ? `/chat/${appSessionId}` : "/")}>
              Open chat
            </Button>
          }
        />
      </PhoneSafeArea>
    );
  }

  const tool = lookup.tool;
  const status: "running" | "complete" | "error" = tool.status;
  const detail = tool.detail;

  // Args: prefer explicit `args`, fall back to whole detail minus result/output.
  const argsRaw = detail["args"] ?? detail["input"];
  const argsBlock = argsRaw !== undefined ? pretty(argsRaw) : pretty(detail);

  const outputRaw =
    detail["output"] ??
    detail["result"] ??
    detail["summary"] ??
    detail["content"];
  const outputBlock = outputRaw !== undefined ? pretty(outputRaw) : null;

  const diff = parseDiff(detail);
  const todos = parseTodos(detail);

  // The chat-store has no per-tool approval flag (approvals are a separate
  // event kind in `pendingApprovals`). The footer is intentionally hidden
  // until the contract grows a way to surface that linkage.
  const showApprovalFooter = false;

  return (
    <PhoneSafeArea>
      <ExpoStack.Screen options={{ headerShown: false }} />
      <NavBar
        title={tool.name}
        onBack={() => safeBack(appSessionId ? `/chat/${appSessionId}` : "/")}
        trailing={
          <StatusPill kind={statusToPill(status)} label={statusLabel(status)} />
        }
      />
      <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
        <Stack gap={18} style={{ paddingTop: 8 }}>
          <Section title="Args">
            <View style={{ marginHorizontal: 16 }}>
              <MonoBlock>{argsBlock || "(no args)"}</MonoBlock>
            </View>
          </Section>

          {outputBlock ? (
            <Section title="Output">
              <View style={{ marginHorizontal: 16 }}>
                <MonoBlock>{outputBlock}</MonoBlock>
              </View>
            </Section>
          ) : null}

          {diff ? (
            <Section title="Diff">
              <View
                style={{
                  marginHorizontal: 16,
                  borderRadius: 10,
                  overflow: "hidden",
                  backgroundColor: tokens.sunken,
                  borderColor: tokens.lineSoft,
                  borderWidth: 1,
                  paddingVertical: 6,
                }}
              >
                {diff.map((d, i) => (
                  <DiffLine
                    key={`${i}-${d.line}-${d.kind}`}
                    kind={d.kind}
                    no={d.line}
                    text={d.text}
                  />
                ))}
              </View>
            </Section>
          ) : null}

          {todos ? (
            <Section title="Todos">
              <Stack gap={6} style={{ paddingHorizontal: 16 }}>
                {todos.map((t, i) => (
                  <Row key={i} gap={10} align="center">
                    <View
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 4,
                        borderWidth: 1,
                        borderColor: t.done ? tokens.positive : tokens.line,
                        backgroundColor: t.done ? tokens.positive + "1A" : "transparent",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      {t.done ? (
                        <Icon name="check" size={12} color={tokens.positive} />
                      ) : null}
                    </View>
                    <Text
                      kind="body"
                      style={{ flex: 1 }}
                      className={t.done ? "text-ink-3" : ""}
                    >
                      {t.text}
                    </Text>
                  </Row>
                ))}
              </Stack>
            </Section>
          ) : null}

          {showApprovalFooter ? (
            <Stack gap={8} style={{ paddingHorizontal: 16, paddingTop: 8 }}>
              <Button kind="accent" size="lg" full leftIcon="check">
                Approve
              </Button>
              <Button kind="danger" size="lg" full leftIcon="close">
                Reject
              </Button>
            </Stack>
          ) : null}
        </Stack>
      </ScrollView>
    </PhoneSafeArea>
  );
}
