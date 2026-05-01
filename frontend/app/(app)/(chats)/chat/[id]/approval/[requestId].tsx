/**
 * Approval modal (full-screen) — Stage 6 satellite.
 *
 * Visual target: design_handoff_hermes/design/screens-4.jsx::ApprovalModal.
 *
 * Presented as a modal route. Two trigger paths:
 *   1. Push notification deep-link tap when the chat isn't currently open.
 *   2. Manual fallback when the inline ApprovalCard was dismissed.
 *
 * The modal mounts its own `useChatStream` so it can send `approval.respond`.
 * That briefly opens a second socket while the chat screen's socket is also
 * alive — the gateway tolerates concurrent sockets per session, and the
 * modal's socket closes on unmount (immediately after `router.back()`).
 *
 * If the approval has already been resolved (or the session isn't loaded
 * for cold deep-links), we render an empty state.
 */
import React, { useCallback } from "react";
import { ScrollView, View } from "react-native";
import { Stack as ExpoStack, router, useLocalSearchParams } from "expo-router";
import {
  Button,
  EmptyState,
  Icon,
  MonoBlock,
  NavBar,
  PhoneSafeArea,
  Row,
  Stack,
  Text,
  useThemeTokens,
} from "@/components/ui";
import { useApprovalFromStore } from "@/hooks/useApprovalFromStore";
import { useChatStream } from "@/ws/use-chat-stream";

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function pickCommand(raw: Record<string, unknown>): string | null {
  return (
    asString(raw["command"]) ??
    asString(raw["cmd"]) ??
    asString(raw["argv"]) ??
    asString(raw["script"]) ??
    null
  );
}

function pickReason(raw: Record<string, unknown>): string | null {
  return (
    asString(raw["reason"]) ??
    asString(raw["explanation"]) ??
    asString(raw["why"]) ??
    null
  );
}

export default function ApprovalModalScreen() {
  const params = useLocalSearchParams<{ id: string; requestId: string }>();
  const appSessionId = typeof params.id === "string" ? params.id : null;
  const requestId =
    typeof params.requestId === "string" ? params.requestId : null;
  const tokens = useThemeTokens();

  const approval = useApprovalFromStore(appSessionId, requestId);

  // Always mount the stream — even if approval is missing — so the early-return
  // branch below doesn't violate React hook order. The hook tolerates a null id.
  const { respondApproval, respondSudo, respondClarify, respondSecret } =
    useChatStream(appSessionId);

  const onApprove = useCallback(
    (all: boolean) => {
      if (!approval || !requestId) return;
      switch (approval.kind) {
        case "approval":
          respondApproval(requestId, "approve", all);
          break;
        case "sudo":
          respondSudo(requestId, "approve");
          break;
        case "clarify":
          // Clarify isn't a yes/no — but if reached via this modal we treat
          // "approve" as an empty acknowledgement to avoid a dead-end UI.
          respondClarify(requestId, "");
          break;
        case "secret":
          // No value to provide here; reject path is the safer default.
          respondSecret(requestId, "");
          break;
      }
      router.back();
    },
    [approval, requestId, respondApproval, respondSudo, respondClarify, respondSecret],
  );

  const onReject = useCallback(() => {
    if (!approval || !requestId) return;
    switch (approval.kind) {
      case "approval":
        respondApproval(requestId, "deny");
        break;
      case "sudo":
        respondSudo(requestId, "deny");
        break;
      case "clarify":
        respondClarify(requestId, "");
        break;
      case "secret":
        respondSecret(requestId, "");
        break;
    }
    router.back();
  }, [approval, requestId, respondApproval, respondSudo, respondClarify, respondSecret]);

  if (!approval) {
    return (
      <PhoneSafeArea>
        <ExpoStack.Screen options={{ headerShown: false, presentation: "modal" }} />
        <NavBar title="Approval" onBack={() => router.back()} />
        <EmptyState
          icon="shield"
          title="Approval no longer pending"
          body="This request has already been resolved or the session is not loaded."
          action={
            <Button kind="secondary" onPress={() => router.back()}>
              Back
            </Button>
          }
        />
      </PhoneSafeArea>
    );
  }

  const command = pickCommand(approval.raw);
  const reason = pickReason(approval.raw);

  return (
    <PhoneSafeArea>
      <ExpoStack.Screen options={{ headerShown: false, presentation: "modal" }} />
      <NavBar title="Approval" onBack={() => router.back()} />
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 8,
          paddingBottom: 24,
          flexGrow: 1,
        }}
      >
        <Stack gap={20} style={{ flex: 1 }}>
          <View
            style={{
              padding: 14,
              backgroundColor: tokens.surface,
              borderRadius: 16,
              borderWidth: 1,
              // ~25% alpha approximates the design's "warning + 40 alpha" border.
              borderColor: tokens.warning + "66",
            }}
          >
            <Stack gap={10}>
              <Row gap={10} align="center">
                <Icon name="shield" size={20} color={tokens.warning} />
                <Text kind="label" color={tokens.warning}>
                  Approval requested
                </Text>
              </Row>
              {approval.prompt ? (
                <Text kind="body" className="text-ink-2">
                  {approval.prompt}
                </Text>
              ) : null}
            </Stack>
          </View>

          {command ? (
            <Stack gap={6}>
              <Text kind="micro" className="text-ink-3 uppercase" style={{ paddingHorizontal: 4 }}>
                Command
              </Text>
              <MonoBlock>{`$ ${command}`}</MonoBlock>
            </Stack>
          ) : null}

          {reason ? (
            <Stack gap={6}>
              <Text kind="micro" className="text-ink-3 uppercase" style={{ paddingHorizontal: 4 }}>
                Reason
              </Text>
              <Text kind="caption" className="text-ink-3">
                {reason}
              </Text>
            </Stack>
          ) : null}

          <View style={{ flex: 1 }} />

          <Stack gap={10}>
            <Button
              kind="accent"
              size="lg"
              full
              leftIcon="check"
              onPress={() => onApprove(false)}
            >
              Approve once
            </Button>
            <Button
              kind="secondary"
              size="md"
              full
              onPress={() => onApprove(true)}
            >
              Approve always
            </Button>
            <Button
              kind="danger"
              size="md"
              full
              leftIcon="close"
              onPress={onReject}
            >
              Reject
            </Button>
          </Stack>
        </Stack>
      </ScrollView>
    </PhoneSafeArea>
  );
}
