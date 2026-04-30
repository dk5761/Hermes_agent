import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { WS_URL } from "../config";
import { getAuthSnapshot } from "../auth/store";
import { useChatStore } from "../state/chat-store";
import { GatewayWsClient, type ConnectionStatus } from "./client";
import type { ClientFrame } from "./events";
import type { AttachmentDTO } from "../api/types";

// Hook glue between GatewayWsClient and Zustand chat-store, scoped to one
// app_session_id. Owns the socket lifecycle for the chat screen mount.

export interface ChatStreamApi {
  status: ConnectionStatus;
  retryInMs: number | null;
  send: (text: string, attachments?: AttachmentDTO[]) => void;
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

    const offEvent = client.onEvent((env) => {
      applyEnvelope(appSessionId, env);
    });
    const offStatus = client.onStatus((s, info) => {
      setStatus(s);
      setRetryInMs(info?.retryInMs ?? null);
    });

    client.connect();
    return () => {
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
      pushUserMessage(appSessionId, trimmed, attachments);
      const attachmentIds = attachments?.map((a) => a.id);
      const frame: ClientFrame =
        hasAttachments && attachmentIds && attachmentIds.length > 0
          ? { type: "chat.send", text: trimmed, attachmentIds }
          : { type: "chat.send", text: trimmed };
      clientRef.current?.send(frame);
    },
    [appSessionId, pushUserMessage],
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
    },
    [],
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
    abort,
    respondApproval,
    respondClarify,
    respondSudo,
    respondSecret,
    acknowledgeSyncRequired,
    raw: clientRef.current,
  };
}
