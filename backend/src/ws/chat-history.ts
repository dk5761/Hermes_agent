import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { chatHistory } from "../db/schema.js";

// Canonical narrative kinds — what a user expects to see when they reload
// a conversation. Streaming-only events (deltas/progress) and internal
// signals (session.info) are deliberately excluded.
export type HistoryKind =
  | "user.message"
  | "assistant.message"
  | "tool.call"
  | "reasoning"
  | "approval.request"
  | "clarify.request"
  | "sudo.request"
  | "secret.request"
  | "error";

export interface HistoryRow {
  id: number;
  kind: HistoryKind;
  payload: Record<string, unknown>;
  createdAt: number;
}

export async function appendHistory(
  db: Db,
  appSessionId: string,
  kind: HistoryKind,
  payload: unknown,
  createdAt?: number,
): Promise<HistoryRow> {
  const ts = createdAt ?? Math.floor(Date.now() / 1000);
  const inserted = await db
    .insert(chatHistory)
    .values({
      appSessionId,
      kind,
      payloadJson: JSON.stringify(payload ?? null),
      createdAt: ts,
    })
    .returning({ id: chatHistory.id });
  const idRow = inserted[0];
  if (!idRow) throw new Error("chat_history insert returned no row");
  return {
    id: idRow.id,
    kind,
    payload: (payload ?? {}) as Record<string, unknown>,
    createdAt: ts,
  };
}

export async function loadHistory(
  db: Db,
  appSessionId: string,
): Promise<HistoryRow[]> {
  const rows = await db
    .select({
      id: chatHistory.id,
      kind: chatHistory.kind,
      payloadJson: chatHistory.payloadJson,
      createdAt: chatHistory.createdAt,
    })
    .from(chatHistory)
    .where(eq(chatHistory.appSessionId, appSessionId))
    .orderBy(asc(chatHistory.id));

  return rows.map<HistoryRow>((r) => {
    let payload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(r.payloadJson);
      if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
    } catch {
      // payload remains {}
    }
    return {
      id: r.id,
      kind: r.kind as HistoryKind,
      payload,
      createdAt: r.createdAt,
    };
  });
}

export async function deleteHistoryForSession(
  db: Db,
  appSessionId: string,
): Promise<void> {
  await db.delete(chatHistory).where(eq(chatHistory.appSessionId, appSessionId));
}

// Helper: extract a plain text body from an arbitrary upstream payload, used
// when persisting. Reads `text`, then `delta`, falls back to "".
export function extractText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const obj = payload as Record<string, unknown>;
  if (typeof obj["text"] === "string") return obj["text"];
  if (typeof obj["delta"] === "string") return obj["delta"];
  return "";
}

// Conditional eq + asc for tests — re-exported to keep the import surface tidy.
export { and, eq };
