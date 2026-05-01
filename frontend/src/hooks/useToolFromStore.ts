/**
 * useToolFromStore — locate a finalized ToolCallCard inside a chat session by id.
 *
 * The chat-store keeps tool cards in `byId[appSessionId].messages` once they
 * complete (the streaming `toolCalls` map is cleared on tool.complete). This
 * hook returns whichever exists — preferring the finalized card.
 *
 * Returns `null` when the session is not loaded or the tool id is unknown
 * (the caller should render a graceful empty state for cold-deeplink cases).
 */
import { useChatStore, type Message, type ToolCallCard, type ToolCallState } from "@/state/chat-store";

export type ToolLookupResult =
  | { kind: "complete"; tool: ToolCallCard }
  | { kind: "running"; tool: ToolCallState }
  | null;

export function useToolFromStore(
  appSessionId: string | null | undefined,
  toolId: string | null | undefined,
): ToolLookupResult {
  return useChatStore((s): ToolLookupResult => {
    if (!appSessionId || !toolId) return null;
    const session = s.byId[appSessionId];
    if (!session) return null;

    // Prefer finalized card (in messages list).
    const finalized: Message | undefined = session.messages.find(
      (m): m is ToolCallCard => m.kind === "tool" && m.id === toolId,
    );
    if (finalized) return { kind: "complete", tool: finalized };

    // Fall back to in-flight tool from the streaming buffer.
    const running = session.streaming?.toolCalls.get(toolId);
    if (running) return { kind: "running", tool: running };

    return null;
  });
}
