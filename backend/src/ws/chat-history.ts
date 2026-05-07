import { and, asc, desc, eq, gt, lte, lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { chatHistory } from "../db/schema.js";
import { extractSearchableText } from "../db/searchable-text.js";

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
  /** Relative URL path like `/voice-blobs/voice/<sha>.m4a`. Null for text-only rows. */
  audioBlobUrl: string | null;
  audioDurationMs: number | null;
  transcriptionStatus: string | null;
  transcriptionError: string | null;
}

export async function appendHistory(
  db: Db,
  appSessionId: string,
  kind: HistoryKind,
  payload: unknown,
  createdAt?: number,
): Promise<HistoryRow> {
  const ts = createdAt ?? Math.floor(Date.now() / 1000);
  // Approach A: populate search_text at write time so the FTS AI trigger
  // mirrors usable content. Backfill indexer covers pre-FTS rows on boot.
  const searchText = extractSearchableText(kind, payload) ?? "";
  const inserted = await db
    .insert(chatHistory)
    .values({
      appSessionId,
      kind,
      payloadJson: JSON.stringify(payload ?? null),
      createdAt: ts,
      searchText,
    })
    .returning({ id: chatHistory.id });
  const idRow = inserted[0];
  if (!idRow) throw new Error("chat_history insert returned no row");
  return {
    id: idRow.id,
    kind,
    payload: (payload ?? {}) as Record<string, unknown>,
    createdAt: ts,
    // appendHistory only writes text/tool rows — no audio fields.
    audioBlobUrl: null,
    audioDurationMs: null,
    transcriptionStatus: null,
    transcriptionError: null,
  };
}

// ---------- paginated load ----------

export interface LoadHistoryOpts {
  /** Page size. Default 50, capped at 100 internally. */
  limit?: number;
  /** Returns rows where chat_history.id < before. Mutually exclusive with `around`. */
  before?: number;
  /** Returns ~limit/2 before + ~limit/2 after the target id. Mutually exclusive with `before`. */
  around?: number;
}

export interface LoadHistoryResult {
  /** Always sorted ascending by id (oldest first). */
  rows: HistoryRow[];
  /** True when older rows exist beyond the returned set. */
  hasBefore: boolean;
  /** True when newer rows exist beyond the returned set. */
  hasAfter: boolean;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

interface RawRow {
  id: number;
  kind: string;
  payloadJson: string;
  createdAt: number;
  audioBlobPath: string | null;
  audioDurationMs: number | null;
  transcriptionStatus: string | null;
  transcriptionError: string | null;
}

function toHistoryRow(r: RawRow): HistoryRow {
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
    // Project the disk-relative path to the URL clients use to fetch the blob.
    // Null on all text-only rows (audio_blob_path is NULL in DB).
    audioBlobUrl: r.audioBlobPath ? `/voice-blobs/${r.audioBlobPath}` : null,
    audioDurationMs: r.audioDurationMs,
    transcriptionStatus: r.transcriptionStatus,
    transcriptionError: r.transcriptionError,
  };
}

const HISTORY_COLUMNS = {
  id: chatHistory.id,
  kind: chatHistory.kind,
  payloadJson: chatHistory.payloadJson,
  createdAt: chatHistory.createdAt,
  audioBlobPath: chatHistory.audioBlobPath,
  audioDurationMs: chatHistory.audioDurationMs,
  transcriptionStatus: chatHistory.transcriptionStatus,
  transcriptionError: chatHistory.transcriptionError,
} as const;

export async function loadHistory(
  db: Db,
  appSessionId: string,
): Promise<HistoryRow[]> {
  const rows = await db
    .select(HISTORY_COLUMNS)
    .from(chatHistory)
    .where(eq(chatHistory.appSessionId, appSessionId))
    .orderBy(asc(chatHistory.id));

  return rows.map(toHistoryRow);
}

export async function loadHistoryWindow(
  db: Db,
  appSessionId: string,
  opts: LoadHistoryOpts = {},
): Promise<LoadHistoryResult> {
  const rawLimit = opts.limit ?? DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(rawLimit)));

  // ---- around-cursor: window centered on target id (split into two halves) ----
  if (opts.around !== undefined) {
    const target = opts.around;
    // halfPlus: rows with id <= target (includes target itself if present).
    // halfRest: rows strictly after target. Sums to `limit`.
    const halfPlus = Math.ceil(limit / 2);
    const halfRest = limit - halfPlus;

    // Left half: id <= target, descending; "+1" probe for hasBefore.
    const leftRaw = await db
      .select(HISTORY_COLUMNS)
      .from(chatHistory)
      .where(and(eq(chatHistory.appSessionId, appSessionId), lte(chatHistory.id, target)))
      .orderBy(desc(chatHistory.id))
      .limit(halfPlus + 1);
    const hasBefore = leftRaw.length > halfPlus;
    const leftTrimmed = hasBefore ? leftRaw.slice(0, halfPlus) : leftRaw;
    const leftAsc = [...leftTrimmed].reverse();

    // Right half: id > target, ascending; "+1" probe for hasAfter. Skipped when
    // halfRest === 0 (only happens for limit === 1; query would still be valid
    // but we save a roundtrip).
    let rightRaw: RawRow[] = [];
    let hasAfter = false;
    if (halfRest > 0) {
      rightRaw = await db
        .select(HISTORY_COLUMNS)
        .from(chatHistory)
        .where(and(eq(chatHistory.appSessionId, appSessionId), gt(chatHistory.id, target)))
        .orderBy(asc(chatHistory.id))
        .limit(halfRest + 1);
      hasAfter = rightRaw.length > halfRest;
    } else {
      // limit === 1 case: probe whether anything exists past target so the
      // caller still knows there's more newer content.
      const probe = await db
        .select({ id: chatHistory.id })
        .from(chatHistory)
        .where(and(eq(chatHistory.appSessionId, appSessionId), gt(chatHistory.id, target)))
        .orderBy(asc(chatHistory.id))
        .limit(1);
      hasAfter = probe.length > 0;
    }
    const rightTrimmed = hasAfter ? rightRaw.slice(0, halfRest) : rightRaw;

    const rows = [...leftAsc.map(toHistoryRow), ...rightTrimmed.map(toHistoryRow)];
    return { rows, hasBefore, hasAfter };
  }

  // ---- before-cursor: page strictly older than `before` ----
  if (opts.before !== undefined) {
    const raw = await db
      .select(HISTORY_COLUMNS)
      .from(chatHistory)
      .where(and(eq(chatHistory.appSessionId, appSessionId), lt(chatHistory.id, opts.before)))
      .orderBy(desc(chatHistory.id))
      .limit(limit + 1);
    const hasBefore = raw.length > limit;
    const trimmed = hasBefore ? raw.slice(0, limit) : raw;
    const rows = [...trimmed].reverse().map(toHistoryRow);
    // hasAfter is always true for a `before` cursor: by definition the caller
    // already holds rows newer than `opts.before`, so there's "more" newer.
    return { rows, hasBefore, hasAfter: true };
  }

  // ---- default: latest page (newest tail of the session) ----
  // Pull `limit + 1` rows in DESC to detect older history without a COUNT.
  const raw = await db
    .select(HISTORY_COLUMNS)
    .from(chatHistory)
    .where(eq(chatHistory.appSessionId, appSessionId))
    .orderBy(desc(chatHistory.id))
    .limit(limit + 1);
  const hasBefore = raw.length > limit;
  const trimmed = hasBefore ? raw.slice(0, limit) : raw;
  const rows = [...trimmed].reverse().map(toHistoryRow);
  return { rows, hasBefore, hasAfter: false };
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
