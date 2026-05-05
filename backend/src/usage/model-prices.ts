/**
 * Model pricing in USD per 1M tokens.
 * Sourced from public provider docs as of 2026-05-05. Update when providers
 * change rates.
 *
 * Cache reads and cache writes have separate rates per Anthropic; for OpenAI
 * cached input is usually 50% of base input. We approximate per-provider:
 *   - Anthropic: cache_read = 0.10x base input, cache_write = 1.25x base input
 *   - OpenAI:    cache_read = 0.50x base input, cache_write = 1.0x base input
 *   - Default:   cache_read = 0.50x, cache_write = 1.0x
 *
 * Add an entry per model the project uses; unknown models fall back to
 * a conservative DEFAULT_RATE that yields zero cost (so we don't bill the
 * user with a guess).
 */
export interface ModelPrice {
  /** Provider used to derive cache discount factors. */
  provider: "anthropic" | "openai" | "google" | "other";
  /** USD per 1M input tokens. */
  inputPer1M: number;
  /** USD per 1M output tokens. */
  outputPer1M: number;
}

export const DEFAULT_RATE: ModelPrice = {
  provider: "other",
  inputPer1M: 0,
  outputPer1M: 0,
};

export const MODEL_PRICES: Record<string, ModelPrice> = {
  // Anthropic — public list pricing per 1M tokens.
  "claude-opus-4": { provider: "anthropic", inputPer1M: 15, outputPer1M: 75 },
  "claude-sonnet-4": { provider: "anthropic", inputPer1M: 3, outputPer1M: 15 },
  "claude-haiku-4-5": { provider: "anthropic", inputPer1M: 1, outputPer1M: 5 },
  // OpenAI — public list pricing per 1M tokens.
  "gpt-5": { provider: "openai", inputPer1M: 1.25, outputPer1M: 10 },
  "gpt-5-mini": { provider: "openai", inputPer1M: 0.25, outputPer1M: 2 },
  // Mimo (other) — Hermes ships this without published pricing. Treat as zero
  // rather than guess so the UI doesn't show a fabricated cost.
  "mimo-v2.5-pro": { provider: "other", inputPer1M: 0, outputPer1M: 0 },
};

/** Per-provider multipliers applied to input rate when the token was cached. */
const CACHE_FACTORS: Record<ModelPrice["provider"], { read: number; write: number }> = {
  anthropic: { read: 0.1, write: 1.25 },
  openai: { read: 0.5, write: 1.0 },
  google: { read: 0.5, write: 1.0 },
  other: { read: 0.5, write: 1.0 },
};

// Rate-limit "unknown model" warnings to once per model per process.
const _warnedUnknownModels = new Set<string>();

/** Returns the price entry for `model`, falling back to DEFAULT_RATE. */
export function priceFor(model: string): ModelPrice {
  const hit = MODEL_PRICES[model];
  if (hit) return hit;
  if (!_warnedUnknownModels.has(model)) {
    _warnedUnknownModels.add(model);
    // Use the host process's logger if wired in later; for now a debug-level
    // console line is sufficient and visible via gateway stdout.
    // eslint-disable-next-line no-console
    console.debug(`[model-prices] unknown model "${model}" — falling back to zero-cost rate`);
  }
  return DEFAULT_RATE;
}

/** Defensive numeric coercion: missing/NaN/negative all collapse to 0. */
function safeNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

export interface UsageInput {
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

/**
 * Compute USD cost for a single assistant turn's usage block.
 *
 * Formula:
 *   effectiveInput = input
 *                  + cache_read  * cacheReadFactor(provider)
 *                  + cache_write * cacheWriteFactor(provider)
 *   cost = (effectiveInput / 1_000_000) * inputPer1M
 *        + (output         / 1_000_000) * outputPer1M
 *
 * Returns 0 for unknown models (DEFAULT_RATE).
 */
export function computeCostUsd(usage: UsageInput): number {
  const price = priceFor(usage.model);
  const factors = CACHE_FACTORS[price.provider];
  const input = safeNum(usage.input);
  const output = safeNum(usage.output);
  const cacheRead = safeNum(usage.cache_read);
  const cacheWrite = safeNum(usage.cache_write);

  const effectiveInput = input + cacheRead * factors.read + cacheWrite * factors.write;
  return (
    (effectiveInput / 1_000_000) * price.inputPer1M +
    (output / 1_000_000) * price.outputPer1M
  );
}
