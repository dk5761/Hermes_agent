// GatewayEventEnvelope — every server-emitted event on /ws is wrapped in this
// shape so clients can resume by `lastEventId` after a reconnect. Defined in
// HERMES_MOBILE_IMPLEMENTATION_PLAN.md §"WebSocket Replay and Resume".

export interface GatewayEventEnvelope<T = unknown> {
  id: number;
  sessionId: string;
  type: string;
  createdAt: string;
  payload: T;
}

export interface GatewayControlMessage {
  // No id — control envelopes are not part of the resumable log.
  type: "gateway.ready" | "sync.required" | "ack" | "control.error";
  payload?: unknown;
}

export function controlMessage(
  type: GatewayControlMessage["type"],
  payload?: unknown,
): string {
  const msg: GatewayControlMessage =
    payload === undefined ? { type } : { type, payload };
  return JSON.stringify(msg);
}

export function envelopeJson<T>(env: GatewayEventEnvelope<T>): string {
  return JSON.stringify(env);
}
