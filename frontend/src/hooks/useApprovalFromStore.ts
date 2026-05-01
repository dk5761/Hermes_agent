/**
 * useApprovalFromStore — resolve a pending ApprovalRequest by its requestId.
 *
 * Returns `null` when the session isn't in-store (cold deep-link from a
 * push notification before the chat screen has mounted) — the caller
 * renders a graceful "approval no longer available" state.
 */
import { useChatStore, type ApprovalRequest } from "@/state/chat-store";

export function useApprovalFromStore(
  appSessionId: string | null | undefined,
  requestId: string | null | undefined,
): ApprovalRequest | null {
  return useChatStore((s): ApprovalRequest | null => {
    if (!appSessionId || !requestId) return null;
    const session = s.byId[appSessionId];
    if (!session) return null;
    return session.pendingApprovals.find((a) => a.requestId === requestId) ?? null;
  });
}
