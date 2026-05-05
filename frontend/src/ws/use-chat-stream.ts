import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { WS_URL } from "../config";
import { getAuthSnapshot } from "../auth/store";
import { useChatStore } from "../state/chat-store";
import { GatewayWsClient, type ConnectionStatus } from "./client";
import { attachQueueDrainer } from "./queue-drainer";
import type { ClientFrame } from "./events";
import type { AttachmentDTO } from "../api/types";
import { usePendingSends } from "../state/pending-sends";
import {
  approvalPending,
  approvalResolved,
  chatRunEnded,
  chatRunStarted,
  chatRunUpdated,
} from "../live-activity/bridge";
import { IosToolsHandler } from "../ios-tools";

// Hook glue between GatewayWsClient and Zustand chat-store, scoped to one
// app_session_id. Owns the socket lifecycle for the chat screen mount.

export interface ChatStreamApi {
  status: ConnectionStatus;
  retryInMs: number | null;
  send: (text: string, attachments?: AttachmentDTO[]) => void;
  // Re-runs the last user turn with the same input. Locally truncates the
  // chat-store from the last user message and tells the backend to drop the
  // last turn from chat_history + ws_events + Hermes' history before re-
  // submitting the prompt.
  regenerate: (text: string, attachments?: AttachmentDTO[]) => void;
  abort: () => void;
  respondApproval: (requestId: string, choice: string, all?: boolean) => void;
  respondClarify: (requestId: string, text: string) => void;
  respondSudo: (requestId: string, choice: string) => void;
  respondSecret: (requestId: string, value: string) => void;
  acknowledgeSyncRequired: () => void;
  raw: GatewayWsClient | null;
}

export function useChatStream(appSessionId: string | null): ChatStreamApi {
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [retryInMs, setRetryInMs] = useState<number | null>(null);
  const clientRef = useRef<GatewayWsClient | null>(null);
  const ensure = useChatStore((s) => s.ensure);
  const applyEnvelope = useChatStore((s) => s.applyEnvelope);
  const pushUserMessage = useChatStore((s) => s.pushUserMessage);
  const truncateLastTurn = useChatStore((s) => s.truncateLastTurn);
  const resetSession = useChatStore((s) => s.reset);
  const queryClient = useQueryClient();

  // Stable starting lastEventId for this connection — avoids restarting from 0
  // when remounting after a transient unmount.
  const initialLastEventId = useMemo(() => {
    if (!appSessionId) return 0;
    return useChatStore.getState().byId[appSessionId]?.lastEventId ?? 0;
  }, [appSessionId]);

  useEffect(() => {
    if (!appSessionId) return;
    ensure(appSessionId);

    const client = new GatewayWsClient({
      wsUrl: WS_URL,
      appSessionId,
      getToken: () => getAuthSnapshot().accessToken,
      initialLastEventId,
    });
    clientRef.current = client;

    // The app-level IosToolsRootSocket is the primary route for native tool
    // calls. Keeping this handler on chat sockets gives us a compatible
    // fallback while a thread is open; the backend can track multiple sockets
    // per user and will send a given call to one live connection.
    const iosToolsHandler = new IosToolsHandler({
      sendFrame: (serialized) => client.sendRaw(serialized),
    });
    const offRawFrame = client.onRawFrame((frame) =>
      iosToolsHandler.onIncomingFrame(frame),
    );

    const offEvent = client.onEvent((env) => {
      applyEnvelope(appSessionId, env);
      // Invalidate the sessions list when a turn completes so the list's
      // preview/title reflects the latest message without a manual refresh.
      // (Sessions list also refetches on tab focus as a safety net.)
      if (env.type === "message.complete" || env.type === "gateway.user.message") {
        void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      }

      // Drive ActivityKit (iOS 16.2+ only). All calls no-op on other
      // platforms via the native module stub.
      const sessions = queryClient.getQueryData<{
        sessions: Array<{ id: string; title: string }>;
      }>(["sessions"]);
      const titleForActivity =
        sessions?.sessions.find((s) => s.id === appSessionId)?.title ?? "Hermes";
      const payload = (env.payload ?? {}) as Record<string, unknown>;
      const asString = (k: string): string | undefined =>
        typeof payload[k] === "string" ? (payload[k] as string) : undefined;
      switch (env.type) {
        case "message.start": {
          void chatRunStarted(appSessionId, titleForActivity, null);
          break;
        }
        case "tool.start":
        case "tool.update":
        case "tool.progress":
        case "tool.generating": {
          const name =
            asString("name") ?? asString("tool") ?? asString("tool_name") ?? "tool";
          void chatRunUpdated(appSessionId, { status: "tool", detail: name });
          break;
        }
        case "tool.complete": {
          void chatRunUpdated(appSessionId, { status: "thinking", detail: null });
          break;
        }
        case "message.delta":
        case "reasoning.available": {
          void chatRunUpdated(appSessionId, { status: "responding", detail: null });
          break;
        }
        case "message.complete":
        case "error": {
          void chatRunEnded(appSessionId);
          break;
        }
        case "approval.request": {
          const cmd =
            asString("command") ??
            asString("prompt") ??
            asString("question") ??
            "Awaiting approval";
          void approvalPending(appSessionId, titleForActivity, cmd);
          break;
        }
      }
    });
    const offStatus = client.onStatus((s, info) => {
      setStatus(s);
      setRetryInMs(info?.retryInMs ?? null);
    });

    // Drainer flushes the offline queue (pending-sends store) on every WS
    // status transition INTO "open". Scoped to this session so concurrent
    // chat screens don't interfere with each other's queues.
    const detachDrainer = attachQueueDrainer({ client, sessionId: appSessionId });

    client.connect();
    return () => {
      detachDrainer();
      offRawFrame();
      offEvent();
      offStatus();
      client.close();
      clientRef.current = null;
    };
  }, [appSessionId, ensure, applyEnvelope, initialLastEventId]);

  const send = useCallback(
    (text: string, attachments?: AttachmentDTO[]) => {
      if (!appSessionId) return;
      const trimmed = text.trim();
      const hasAttachments = (attachments?.length ?? 0) > 0;
      // Permit empty text when attachments are present — gateway treats
      // attachment-only sends as an implicit "describe these" prompt.
      if (!trimmed && !hasAttachments) return;
      const attachmentIds = attachments?.map((a) => a.id);
      const frame: ClientFrame =
        hasAttachments && attachmentIds && attachmentIds.length > 0
          ? { type: "chat.send", text: trimmed, attachmentIds }
          : { type: "chat.send", text: trimmed };
      // Always enqueue first — this is the durable record that survives an
      // app kill or a flaky network. The bubble carries the same id so the
      // renderer can paint queued/sending/failed dots.
      const pendingId = usePendingSends
        .getState()
        .enqueue(appSessionId, frame);
      pushUserMessage(appSessionId, trimmed, attachments, pendingId);
      // Fast path: if WS is already open, send immediately and dequeue
      // synchronously so the dot doesn't flash on a healthy connection.
      const client = clientRef.current;
      if (client && client.getStatus() === "open") {
        try {
          usePendingSends.getState().markSending(pendingId);
          client.send(frame);
          usePendingSends.getState().markSent(pendingId);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : "send failed";
          usePendingSends.getState().markFailed(pendingId, msg);
        }
      }
      // Else: drainer (attached in the WS effect) will pick it up on the
      // next "open" transition.
    },
    [appSessionId, pushUserMessage],
  );

  const regenerate = useCallback(
    (text: string, attachments?: AttachmentDTO[]) => {
      if (!appSessionId) return;
      const trimmed = text.trim();
      const hasAttachments = (attachments?.length ?? 0) > 0;
      if (!trimmed && !hasAttachments) return;
      // Locally drop the prior turn first so the user sees the old answer
      // disappear immediately; the new one will stream into its place once
      // the backend acks the re-submission. Note: any prior queued frame
      // for this session is INTENTIONALLY left alone — the user explicitly
      // enqueued that text and regenerate replaces only the last turn UI,
      // not the offline queue history.
      truncateLastTurn(appSessionId);
      const attachmentIds = attachments?.map((a) => a.id);
      const frame: ClientFrame =
        hasAttachments && attachmentIds && attachmentIds.length > 0
          ? { type: "chat.send", text: trimmed, attachmentIds, regenerate: true }
          : { type: "chat.send", text: trimmed, regenerate: true };
      const pendingId = usePendingSends
        .getState()
        .enqueue(appSessionId, frame);
      pushUserMessage(appSessionId, trimmed, attachments, pendingId);
      const client = clientRef.current;
      if (client && client.getStatus() === "open") {
        try {
          usePendingSends.getState().markSending(pendingId);
          client.send(frame);
          usePendingSends.getState().markSent(pendingId);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : "send failed";
          usePendingSends.getState().markFailed(pendingId, msg);
        }
      }
    },
    [appSessionId, pushUserMessage, truncateLastTurn],
  );

  const abort = useCallback(() => {
    clientRef.current?.send({ type: "chat.abort" });
  }, []);

  const respondApproval = useCallback(
    (requestId: string, choice: string, all?: boolean) => {
      const frame: ClientFrame =
        all === undefined
          ? { type: "approval.respond", requestId, choice }
          : { type: "approval.respond", requestId, choice, all };
      clientRef.current?.send(frame);
      if (appSessionId) void approvalResolved(appSessionId);
    },
    [appSessionId],
  );
  const respondClarify = useCallback((requestId: string, text: string) => {
    clientRef.current?.send({ type: "clarify.respond", requestId, text });
  }, []);
  const respondSudo = useCallback((requestId: string, choice: string) => {
    clientRef.current?.send({ type: "sudo.respond", requestId, choice });
  }, []);
  const respondSecret = useCallback((requestId: string, value: string) => {
    clientRef.current?.send({ type: "secret.respond", requestId, value });
  }, []);

  const acknowledgeSyncRequired = useCallback(() => {
    if (!appSessionId) return;
    resetSession(appSessionId);
    void queryClient.invalidateQueries({ queryKey: ["session-messages", appSessionId] });
    clientRef.current?.acknowledgeSyncRequired();
  }, [appSessionId, resetSession, queryClient]);

  return {
    status,
    retryInMs,
    send,
    regenerate,
    abort,
    respondApproval,
    respondClarify,
    respondSudo,
    respondSecret,
    acknowledgeSyncRequired,
    raw: clientRef.current,
  };
}
