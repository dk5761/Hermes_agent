/**
 * queue-drainer — bridges pending-sends ←→ GatewayWsClient.
 *
 * Subscribes to WebSocket status changes. On every transition INTO "open"
 * (and only on transitions — not on every "open" tick), drains queued
 * frames for the given session in enqueue order. Each frame is marked
 * `sending` before send and `sent` (removed) on success; failures bump
 * the retries counter and stop the drain pass so we don't hammer a
 * half-broken socket.
 *
 * If the queue still has retryable frames after a pass, schedule another
 * drain with backoff (1s → 5s → 30s based on accumulated retries). A
 * frame that hits 3 retries stays `failed` forever — the user must hit
 * Retry or Delete via the long-press menu on the bubble.
 *
 * Lifecycle: returned function unsubscribes the status listener AND
 * cancels any pending backoff timer. The chat screen wires this into the
 * same useEffect that owns the GatewayWsClient so unmounting tears down
 * cleanly.
 *
 * Ordering note: regenerate() truncates the last turn locally and pushes a
 * new user message. Any *prior* queued frame is independent — its bubble
 * was already removed by the truncate, but the frame itself stays in the
 * queue and the drainer will still try to send it. This is intentional;
 * the user explicitly enqueued that text and we shouldn't drop it on
 * regenerate. The orphaned frame will fail server-side or land as a
 * separate user.message, depending on backend semantics.
 */
import type { ConnectionStatus, GatewayWsClient } from "./client";
import { usePendingSends } from "../state/pending-sends";

const BACKOFFS_MS = [1_000, 5_000, 30_000] as const;
const MAX_RETRIES = 3;

export interface AttachQueueDrainerArgs {
  client: GatewayWsClient;
  sessionId: string;
}

export function attachQueueDrainer(args: AttachQueueDrainerArgs): () => void {
  const { client, sessionId } = args;
  let prevStatus: ConnectionStatus = client.getStatus();
  let backoffTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const clearBackoff = (): void => {
    if (backoffTimer !== null) {
      clearTimeout(backoffTimer);
      backoffTimer = null;
    }
  };

  const scheduleNext = (delayMs: number): void => {
    clearBackoff();
    backoffTimer = setTimeout(() => {
      backoffTimer = null;
      if (disposed) return;
      if (client.getStatus() !== "open") return;
      drain();
    }, delayMs);
  };

  const drain = (): void => {
    if (disposed) return;
    if (client.getStatus() !== "open") return;
    const store = usePendingSends.getState();
    // `sending` rows from a previous pass that errored mid-flight stay
    // visible but aren't re-tried in the same pass — we'll see them again
    // on the next status transition.
    const queue = store
      .framesForSession(sessionId)
      .filter((f) => f.status === "queued");
    if (queue.length === 0) return;

    let stoppedByError = false;
    let maxRetriesSeen = 0;

    for (const f of queue) {
      if (disposed) return;
      if (f.retries >= MAX_RETRIES) {
        // Already exhausted — leave it `failed` for manual recovery.
        usePendingSends
          .getState()
          .markFailed(f.id, f.lastError ?? "max retries");
        continue;
      }
      usePendingSends.getState().markSending(f.id);
      try {
        // RN WebSocket.send is synchronous and doesn't throw on a healthy
        // socket; if the socket flipped between the status check above
        // and this call, GatewayWsClient.send no-ops silently. The frame
        // would then sit in `sending` until the next status change — we
        // recover those by leaving them as `queued` after no-op (see
        // post-loop guard below).
        client.send(f.frame);
        usePendingSends.getState().markSent(f.id);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "send failed";
        usePendingSends.getState().markFailed(f.id, msg);
        stoppedByError = true;
        maxRetriesSeen = Math.max(maxRetriesSeen, f.retries + 1);
        // Don't keep flushing — back off and let the next pass try again.
        break;
      }
    }

    // Recovery: any frame that's STILL `sending` after the loop means
    // client.send() silently no-op'd (socket flipped). Reset to queued so
    // the next drain picks it up.
    const after = usePendingSends.getState().framesForSession(sessionId);
    for (const f of after) {
      if (f.status === "sending") {
        usePendingSends.getState().retry(f.id);
      }
    }

    // If we stopped due to error and there's still work, schedule a retry.
    const remaining = usePendingSends
      .getState()
      .framesForSession(sessionId)
      .filter((f) => f.status === "queued" && f.retries < MAX_RETRIES);
    if (remaining.length > 0 && stoppedByError) {
      const idx = Math.min(maxRetriesSeen, BACKOFFS_MS.length - 1);
      scheduleNext(BACKOFFS_MS[idx] ?? BACKOFFS_MS[BACKOFFS_MS.length - 1]!);
    }
  };

  const offStatus = client.onStatus((next) => {
    const transitioned = prevStatus !== "open" && next === "open";
    prevStatus = next;
    if (next !== "open") {
      // Network dropped mid-drain: stop scheduled retries — they'd no-op
      // anyway, but cancelling avoids a stale timer firing right after a
      // reconnect window opens and racing the on-open trigger.
      clearBackoff();
      return;
    }
    if (transitioned) drain();
  });

  // If the socket was already open at attach time (race-prone scenario:
  // queue-drainer mounts after the WS opened but before the first status
  // event fired), kick off an initial drain pass.
  if (client.getStatus() === "open") drain();

  return () => {
    disposed = true;
    clearBackoff();
    offStatus();
  };
}
