/**
 * mutation-drainer — bridges pending-mutations ←→ the network.
 *
 * Subscribes to {@link useNetworkStatus} and {@link usePendingMutations}.
 * Whenever:
 *   1. `online` flips false → true (rising edge), OR
 *   2. the queue grows while we're already online,
 * the drainer wakes and processes entries serially in enqueue order.
 *
 * Per entry:
 *   - `failed === true` → skip (user can re-arm via Diagnostics).
 *   - 404 (session was deleted between enqueue and replay) → silently drop.
 *     Common when a delete + rename race offline; the rename gets a 404
 *     and we don't want to surface that as a real error.
 *   - 401 / 403 → pause draining. The api/client.ts auth refresh path
 *     will eventually flip the user back online or kick them to login.
 *     Bumping retries here would just chew through the cap.
 *   - 5xx / network errors / unexpected throws → bumpRetry. After the cap
 *     the entry flips to `failed: true` and stops being drained.
 *
 * Backoff: 0ms after a successful entry (drain as fast as the network
 * allows). Before each entry that has retries > 0 we sleep based on its
 * accumulated retry count: 1s / 5s / 30s. This batches rebuffs from a
 * still-flaky connection so we don't burn through the retry budget in
 * milliseconds.
 *
 * Concurrency: a single `draining` flag gates the loop so the two
 * subscription triggers (network + queue) can't kick off parallel passes.
 * If the loop is already running when a trigger fires, it does nothing —
 * the in-flight loop will see new entries on its next iteration via a
 * fresh `getState()` read.
 *
 * Lifecycle: returned function unsubscribes both listeners and flips a
 * `disposed` flag so any in-flight backoff sleep no-ops on wake. Mounted
 * once at the app level (see app/_layout.tsx).
 */
import type { QueryClient } from "@tanstack/react-query";

import { usePendingMutations, MAX_RETRIES } from "../state/pending-mutations";
import type {
  PendingMutation,
  PendingMutationEntry,
} from "../state/pending-mutations";
import { useNetworkStatus } from "../state/network-status";
import {
  archiveSession,
  deleteSession,
  renameSession,
  setSessionModel,
} from "../api/sessions";
import { ApiError } from "../api/types";

const BACKOFFS_MS = [1_000, 5_000, 30_000] as const;
const SESSIONS_KEY = ["sessions"] as const;

export interface AttachMutationDrainerArgs {
  queryClient: QueryClient;
}

export function attachMutationDrainer(
  args: AttachMutationDrainerArgs,
): () => void {
  const { queryClient } = args;

  let disposed = false;
  let draining = false;
  let paused = false;

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      // If disposed mid-sleep we don't bother clearing the timer — the
      // post-sleep `disposed` check will short-circuit the loop. Keeping a
      // handle around adds complexity without meaningful benefit.
      void t;
    });

  const dispatch = async (mutation: PendingMutation): Promise<void> => {
    switch (mutation.kind) {
      case "session.archive":
        await archiveSession(
          mutation.payload.sessionId,
          mutation.payload.archived,
        );
        return;
      case "session.rename":
        await renameSession(
          mutation.payload.sessionId,
          mutation.payload.title,
        );
        return;
      case "session.delete":
        await deleteSession(mutation.payload.sessionId);
        return;
      case "session.setModel": {
        const p = mutation.payload;
        if ("clear" in p) {
          await setSessionModel(p.sessionId, { clear: true });
        } else {
          await setSessionModel(p.sessionId, {
            provider: p.provider,
            model: p.model,
          });
        }
        return;
      }
      default: {
        // Exhaustiveness check — adding a new PendingMutation branch
        // without updating this switch becomes a compile error.
        const _exhaustive: never = mutation;
        void _exhaustive;
        return;
      }
    }
  };

  const drain = async (): Promise<void> => {
    if (disposed || draining) return;
    if (!useNetworkStatus.getState().online) return;
    draining = true;
    paused = false;

    try {
      // Loop until the queue is exhausted (or we hit a pause / dispose).
      // Each iteration re-reads getState() so newly-enqueued items during
      // a long drain pass are picked up without restarting the loop.
      while (!disposed && !paused) {
        if (!useNetworkStatus.getState().online) break;
        const queue = usePendingMutations.getState().queue;
        const entry: PendingMutationEntry | undefined = queue.find(
          (e) => !e.failed,
        );
        if (!entry) break;

        // Backoff before the entry if it's already accumulated retries.
        // First-attempt entries (retries === 0) drain at full speed.
        if (entry.retries > 0) {
          const idx = Math.min(entry.retries - 1, BACKOFFS_MS.length - 1);
          const delay = BACKOFFS_MS[idx] ?? BACKOFFS_MS[BACKOFFS_MS.length - 1]!;
          await sleep(delay);
          if (disposed) break;
          if (!useNetworkStatus.getState().online) break;
        }

        try {
          await dispatch(entry.mutation);
          // Success — drop from queue + invalidate sessions cache so the UI
          // matches the backend after the drain completes.
          usePendingMutations.getState().remove(entry.id);
          void queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
        } catch (err: unknown) {
          if (err instanceof ApiError) {
            if (err.status === 404) {
              // Predicate session no longer exists. A common race: delete
              // + rename queued offline; rename lands and 404s.
              if (__DEV__) {
                // eslint-disable-next-line no-console
                console.info(
                  "[mutation-drainer] dropping %s (404 — predicate gone)",
                  entry.mutation.kind,
                );
              }
              usePendingMutations.getState().remove(entry.id);
              continue;
            }
            if (err.status === 401 || err.status === 403) {
              // Pause without bumping. The auth refresh path inside
              // apiFetch already attempted once; if we reached here, the
              // user needs to re-auth. Resume on the next online tick.
              paused = true;
              break;
            }
            // 5xx and other ApiError statuses: transient → bump retry.
            usePendingMutations
              .getState()
              .bumpRetry(entry.id, err.message);
            // If we just hit the cap on this entry the next loop iter
            // will see it as `failed` and skip it. Don't break — there
            // may be newer entries we can still drain.
            if (entry.retries + 1 >= MAX_RETRIES) continue;
            // Pause briefly between retries on the SAME entry — but the
            // loop's `find(!failed)` will surface the same entry again so
            // its `retries > 0` branch will pick the right backoff. No
            // explicit sleep here; let the next iteration handle it.
            continue;
          }
          // Network error or programmer mistake — treat as transient.
          const msg = err instanceof Error ? err.message : "unknown error";
          usePendingMutations.getState().bumpRetry(entry.id, msg);
          continue;
        }
      }
    } finally {
      draining = false;
    }
  };

  // Trigger 1: rising edge of `online`. Note we only kick off when the
  // value flips true; the queue listener handles the case where we're
  // already online and an enqueue happens.
  let prevOnline = useNetworkStatus.getState().online;
  const offNetwork = useNetworkStatus.subscribe((s) => {
    const next = s.online;
    const transitioned = !prevOnline && next;
    prevOnline = next;
    if (transitioned) {
      void drain();
    }
  });

  // Trigger 2: queue growth while online. Catches the case where a brand-
  // new offline enqueue happens to coincide with `online: true` (e.g. user
  // was online but the WS path was unrelated and the immediate-send still
  // failed for some other reason).
  let prevQueueLen = usePendingMutations.getState().queue.length;
  const offQueue = usePendingMutations.subscribe((s) => {
    const next = s.queue.length;
    const grew = next > prevQueueLen;
    prevQueueLen = next;
    if (grew && useNetworkStatus.getState().online) {
      void drain();
    }
  });

  // Initial kick: if we're already online at attach time AND the queue is
  // non-empty (e.g. carried over from a previous launch), drain now.
  if (useNetworkStatus.getState().online) {
    void drain();
  }

  return () => {
    disposed = true;
    offNetwork();
    offQueue();
  };
}
