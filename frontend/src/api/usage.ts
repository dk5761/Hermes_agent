/**
 * /analytics/usage proxy client.
 *
 * The gateway proxies Hermes' GET /api/analytics/usage?days=. Response shape
 * is loosely typed — Hermes evolves this surface; we coerce defensively.
 *
 * Expected shape (best-effort):
 *   {
 *     totalCost?: number,
 *     totalTokens?: { in?: number; out?: number; cached?: number },
 *     totalCalls?: number,
 *     range?: { start?: string; end?: string },
 *     byDay?: Array<{ date: string; cost: number; tokensIn?: number; tokensOut?: number; cached?: number }>,
 *     byModel?: Array<{ model: string; provider?: string; cost: number; calls?: number }>,
 *   }
 */
import { apiFetch } from "./client";

export interface UsageDay {
  date: string;
  cost: number;
  tokensIn: number;
  tokensOut: number;
  cached: number;
}

export interface UsageModel {
  model: string;
  provider?: string;
  cost: number;
  calls: number;
}

export interface UsageRange {
  start?: string;
  end?: string;
}

export interface UsageResponse {
  totalCost: number;
  totalTokens: { in: number; out: number; cached: number };
  totalCalls: number;
  range: UsageRange;
  byDay: UsageDay[];
  byModel: UsageModel[];
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asUsage(raw: unknown): UsageResponse {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const totalTokensRaw = (r.totalTokens && typeof r.totalTokens === "object"
    ? r.totalTokens
    : {}) as Record<string, unknown>;
  const rangeRaw = (r.range && typeof r.range === "object"
    ? r.range
    : {}) as Record<string, unknown>;
  const byDayRaw = Array.isArray(r.byDay) ? r.byDay : [];
  const byModelRaw = Array.isArray(r.byModel) ? r.byModel : [];

  const byDay: UsageDay[] = byDayRaw.map((d) => {
    const x = (d && typeof d === "object" ? d : {}) as Record<string, unknown>;
    return {
      date: str(x.date) ?? "",
      cost: num(x.cost),
      tokensIn: num(x.tokensIn),
      tokensOut: num(x.tokensOut),
      cached: num(x.cached),
    };
  });

  const byModel: UsageModel[] = byModelRaw.map((m) => {
    const x = (m && typeof m === "object" ? m : {}) as Record<string, unknown>;
    return {
      model: str(x.model) ?? "(unknown)",
      provider: str(x.provider),
      cost: num(x.cost),
      calls: num(x.calls),
    };
  });

  return {
    totalCost: num(r.totalCost),
    totalTokens: {
      in: num(totalTokensRaw.in),
      out: num(totalTokensRaw.out),
      cached: num(totalTokensRaw.cached),
    },
    totalCalls: num(r.totalCalls),
    range: { start: str(rangeRaw.start), end: str(rangeRaw.end) },
    byDay,
    byModel,
  };
}

export type UsageRangeDays = 7 | 30 | 90;

export async function getUsage(days: UsageRangeDays): Promise<UsageResponse> {
  const data = await apiFetch<unknown>("/analytics/usage", { query: { days } });
  return asUsage(data);
}
