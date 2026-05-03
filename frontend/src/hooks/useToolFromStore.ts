/**
 * useToolFromStore — locate a finalized ToolCallCard inside a chat session by id.
 *
 * The chat-store keeps tool cards in `byId[appSessionId].messages` once they
 * complete (the streaming `toolCalls` map is cleared on tool.complete). This
 * hook returns whichever exists — preferring the finalized card.
 *
 * Returns `null` when the session is not loaded or the tool id is unknown
 * (the caller should render a graceful empty state for cold-deeplink cases).
 *
 * IMPORTANT: the selector returns the raw tool reference (stable across
 * renders) and the caller composes the `{kind, tool}` wrapper. Returning a
 * fresh wrapper *inside* the selector breaks Zustand's default `===` change
 * detection — every render produces a new object, Zustand thinks state
 * changed, schedules an update, repeat → "Maximum update depth exceeded."
 */
import {
  useChatStore,
  type Message,
  type ToolCallCard,
  type ToolCallState,
} from "@/state/chat-store";

export type ToolLookupResult =
  | { kind: "complete"; tool: ToolCallCard }
  | { kind: "running"; tool: ToolCallState }
  | null;

type RawTool = ToolCallCard | ToolCallState | null;

export function useToolFromStore(
  appSessionId: string | null | undefined,
  toolId: string | null | undefined,
): ToolLookupResult {
  const tool: RawTool = useChatStore((s): RawTool => {
    if (!appSessionId || !toolId) return null;
    const session = s.byId[appSessionId];
    if (!session) return null;
    // Prefer the finalized card (in messages list).
    const finalized: Message | undefined = session.messages.find(
      (m): m is ToolCallCard => m.kind === "tool" && m.id === toolId,
    );
    if (finalized) return finalized;
    // Fall back to the in-flight tool from the streaming buffer.
    return session.streaming?.toolCalls.get(toolId) ?? null;
  });

  if (!tool) return null;
  if ("kind" in tool && tool.kind === "tool") {
    return { kind: "complete", tool };
  }
  return { kind: "running", tool: tool as ToolCallState };
}
