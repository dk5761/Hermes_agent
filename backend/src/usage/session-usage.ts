import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { chatHistory } from "../db/schema.js";
import { computeCostUsd, priceFor } from "./model-prices.js";

export interface SessionUsageByModel {
  model: string;
  provider: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  costUsd: number;
}

export interface SessionUsage {
  /** Sum across all turns/models. */
  totals: {
    tokensIn: number;
    tokensOut: number;
    tokensCached: number;
    costUsd: number;
    turns: number;
  };
  /** Per-model breakdown — ordered by costUsd descending. Empty if session is empty. */
  byModel: SessionUsageByModel[];
}

/** Internal accumulator before we project to the public shape. */
interface ModelAccum {
  model: string;
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function safeInt(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/**
 * Pull `usage` from a parsed assistant.message payload. Returns null if the
 * payload is missing/malformed/lacks a model — we'd have nothing to attribute.
 */
function extractUsage(payloadJson: string): {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const usage = obj["usage"];
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const model = typeof u["model"] === "string" ? u["model"] : null;
  if (!model) return null;
  return {
    model,
    input: safeInt(u["input"]),
    output: safeInt(u["output"]),
    cacheRead: safeInt(u["cache_read"]),
    cacheWrite: safeInt(u["cache_write"]),
  };
}

/**
 * Aggregate token usage and computed cost across every assistant.message
 * row for `appSessionId`. Caller is expected to have already verified
 * ownership (this helper does no auth).
 *
 * Edge cases:
 *  - Empty session → zero totals, empty byModel array.
 *  - Rows with malformed/missing usage are silently skipped (they don't
 *    contribute to totals or byModel — but we don't fail the whole query).
 *  - Unknown models contribute tokens but $0 cost (see priceFor / DEFAULT_RATE).
 */
export async function loadSessionUsage(
  db: Db,
  appSessionId: string,
): Promise<SessionUsage> {
  const rows = await db
    .select({ payloadJson: chatHistory.payloadJson })
    .from(chatHistory)
    .where(
      and(
        eq(chatHistory.appSessionId, appSessionId),
        eq(chatHistory.kind, "assistant.message"),
      ),
    );

  const groups = new Map<string, ModelAccum>();
  for (const r of rows) {
    const u = extractUsage(r.payloadJson);
    if (!u) continue;
    let g = groups.get(u.model);
    if (!g) {
      g = {
        model: u.model,
        calls: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      };
      groups.set(u.model, g);
    }
    g.calls += 1;
    g.input += u.input;
    g.output += u.output;
    g.cacheRead += u.cacheRead;
    g.cacheWrite += u.cacheWrite;
  }

  const byModel: SessionUsageByModel[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let tokensCached = 0;
  let costUsd = 0;
  let turns = 0;

  for (const g of groups.values()) {
    const cost = computeCostUsd({
      model: g.model,
      input: g.input,
      output: g.output,
      cache_read: g.cacheRead,
      cache_write: g.cacheWrite,
    });
    const cached = g.cacheRead + g.cacheWrite;
    byModel.push({
      model: g.model,
      provider: priceFor(g.model).provider,
      calls: g.calls,
      tokensIn: g.input,
      tokensOut: g.output,
      tokensCached: cached,
      costUsd: cost,
    });
    tokensIn += g.input;
    tokensOut += g.output;
    tokensCached += cached;
    costUsd += cost;
    turns += g.calls;
  }

  byModel.sort((a, b) => b.costUsd - a.costUsd);

  return {
    totals: { tokensIn, tokensOut, tokensCached, costUsd, turns },
    byModel,
  };
}
