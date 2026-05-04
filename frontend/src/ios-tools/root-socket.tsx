import { useEffect } from "react";
import { Platform } from "react-native";
import { apiFetch } from "../api/client";
import { getAuthSnapshot, useAuthStore } from "../auth/store";
import { WS_URL } from "../config";
import { Backoff } from "../util/backoff";
import { IosToolsHandler } from "./handler";

/**
 * App-level iOS tools transport.
 *
 * Chat screens still have their normal session WS, but native iOS tool calls
 * should not depend on a chat route being mounted. This socket stays alive for
 * the authenticated app session and only handles raw ios_tool_call frames.
 */
export function IosToolsRootSocket(): null {
  const hydrated = useAuthStore((s) => s.hydrated);
  const accessToken = useAuthStore((s) => s.accessToken);
  const isAuthed = useAuthStore((s) => Boolean(s.accessToken && s.user));

  useEffect(() => {
    if (Platform.OS !== "ios") return;
    if (!hydrated || !isAuthed) return;

    let closed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const backoff = new Backoff({ baseMs: 1_000, maxMs: 30_000 });
    let connect: () => void;

    const clearReconnect = (): void => {
      if (!reconnectTimer) return;
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    };

    const scheduleReconnect = (delayMs?: number): void => {
      if (closed) return;
      clearReconnect();
      const delay = delayMs ?? backoff.next();
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    const refreshThenReconnect = (): void => {
      void apiFetch("/health/me")
        .catch(() => undefined)
        .finally(() => scheduleReconnect(1_000));
    };

    const handler = new IosToolsHandler({
      sendFrame: (serialized) => {
        if (socket?.readyState !== WebSocket.OPEN) return;
        socket.send(serialized);
      },
    });

    connect = (): void => {
      if (closed) return;
      const token = getAuthSnapshot().accessToken;
      if (!token) return;

      const params = new URLSearchParams();
      params.set("token", token);
      const nextSocket = new WebSocket(`${WS_URL}/ws/ios-tools?${params.toString()}`);
      socket = nextSocket;

      nextSocket.onopen = () => {
        backoff.reset();
      };

      nextSocket.onmessage = (ev: MessageEvent) => {
        if (typeof ev.data !== "string") return;
        let frame: unknown;
        try {
          frame = JSON.parse(ev.data);
        } catch {
          return;
        }
        handler.onIncomingFrame(frame);
      };

      nextSocket.onerror = () => {
        // React Native follows with onclose; schedule reconnect there so we
        // don't double-enqueue timers.
      };

      nextSocket.onclose = (ev: CloseEvent) => {
        if (socket === nextSocket) socket = null;
        if (closed) return;
        if (ev.code === 4404) {
          // Gateway is healthy but iOS tools are disabled on this deployment.
          // Stop reconnecting until auth/app state changes and remounts us.
          return;
        }
        if (ev.code === 4401) {
          refreshThenReconnect();
          return;
        }
        scheduleReconnect();
      };
    };

    connect();

    return () => {
      closed = true;
      clearReconnect();
      const current = socket;
      socket = null;
      if (current) {
        try {
          current.close(1000, "ios_tools_root_unmount");
        } catch {
          // Already closed.
        }
      }
    };
  }, [hydrated, isAuthed, accessToken]);

  return null;
}
