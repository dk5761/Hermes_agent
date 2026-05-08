import type { GatewayEventEnvelope } from "./envelope.js";

/**
 * Subscribers indexed by app_session_id. Each gateway WS client registers
 * itself for exactly one app session; events fan out 1→N to all listeners
 * for that session.
 *
 * Extracted into its own module so background workers (notably the cron
 * output watcher) can call `emit` on a shared registry — they don't open
 * a WS themselves, but they need to push synthetic envelopes into open
 * chat screens whose users haven't reloaded yet.
 */
export class SubscriberRegistry {
  private readonly subs = new Map<
    string,
    Set<(env: GatewayEventEnvelope) => void>
  >();

  add(
    appSessionId: string,
    fn: (env: GatewayEventEnvelope) => void,
  ): () => void {
    const set = this.subs.get(appSessionId) ?? new Set();
    set.add(fn);
    this.subs.set(appSessionId, set);
    return () => {
      const s = this.subs.get(appSessionId);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) this.subs.delete(appSessionId);
    };
  }

  emit(appSessionId: string, env: GatewayEventEnvelope): void {
    const s = this.subs.get(appSessionId);
    if (!s) return;
    for (const fn of s) {
      try {
        fn(env);
      } catch {
        // Listener-level errors swallowed; the WS handler logs separately.
      }
    }
  }
}
