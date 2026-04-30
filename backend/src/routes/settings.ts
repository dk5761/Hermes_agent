import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { HermesHttpClient } from "../hermes/http-client.js";
import type { AppLogger } from "../logger.js";

export interface SettingsRoutesDeps {
  config: AppConfig;
  requireAuth: preHandlerHookHandler;
  hermesHttp: HermesHttpClient;
  logger: AppLogger;
}

interface VisionProvider {
  id: string;
  label: string;
  envKey?: string;
  needsBaseUrl?: boolean;
  hint?: string;
}

interface VisionCatalog {
  providers: VisionProvider[];
  modelsByProvider: Map<string, string[]>;
  loadedAt: number;
}

// Providers Hermes supports that are NOT in models.dev (OAuth or BYO endpoint).
// These are always offered.
const STATIC_SUPPLEMENTS: ReadonlyArray<VisionProvider> = [
  { id: "auto", label: "Automatic (resolve from chain)", hint: "Hermes picks the first provider with a key set" },
  { id: "custom", label: "Custom (OpenAI-compatible)", needsBaseUrl: true, hint: "Local Pixtral / Qwen-VL / LLaVA via vLLM, Ollama, etc." },
  { id: "nous", label: "Nous Portal" },
  { id: "codex", label: "Codex (gpt-5.3-codex via OAuth)" },
];

const STATIC_SUPPLEMENT_MODELS: Record<string, ReadonlyArray<string>> = {
  custom: ["pixtral-12b", "qwen2.5-vl-7b-instruct", "llava-next-7b"],
  nous: ["hermes-vision"],
  codex: ["gpt-5.3-codex"],
};

const PRETTY_LABELS: Record<string, string> = {
  openrouter: "OpenRouter",
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  zai: "z.ai / GLM",
  xiaomi: "Xiaomi MiMo",
  groq: "Groq",
  perplexity: "Perplexity",
  cerebras: "Cerebras",
  fireworks: "Fireworks",
  together: "Together AI",
  deepinfra: "DeepInfra",
  nvidia: "NVIDIA NIM",
  bedrock: "AWS Bedrock",
  mistral: "Mistral",
  cohere: "Cohere",
  alibaba: "Alibaba (Qwen)",
};

// Static fallback used when the cache file is missing/unreadable, so the UI
// always has *something* to show.
const FALLBACK_CATALOG: VisionCatalog = {
  providers: [
    { id: "openrouter", label: "OpenRouter", envKey: "OPENROUTER_API_KEY" },
    { id: "anthropic", label: "Anthropic", envKey: "ANTHROPIC_API_KEY" },
    { id: "openai", label: "OpenAI", envKey: "OPENAI_API_KEY" },
    { id: "zai", label: "z.ai / GLM", envKey: "ZAI_API_KEY" },
    { id: "xiaomi", label: "Xiaomi MiMo", envKey: "XIAOMI_API_KEY" },
  ],
  modelsByProvider: new Map([
    ["openrouter", ["anthropic/claude-sonnet-4-5", "openai/gpt-4o", "google/gemini-2.5-pro"]],
    ["anthropic", ["claude-sonnet-4-5", "claude-opus-4-5"]],
    ["openai", ["gpt-4o", "gpt-4o-mini"]],
    ["zai", ["glm-5v-turbo", "glm-4.5v"]],
    ["xiaomi", ["mimo-v2.5-pro", "mimo-v2-omni"]],
  ]),
  loadedAt: 0,
};

const CATALOG_TTL_MS = 60_000;

const visionUpdateBody = z.object({
  provider: z.string().min(1).max(40),
  model: z.string().max(200).default(""),
  baseUrl: z.string().max(500).default(""),
  apiKey: z.string().max(500).default(""),
  timeoutS: z.number().int().min(5).max(600).default(120),
});

const suggestedQuery = z.object({ provider: z.string().min(1).max(40) });

export async function registerSettingsRoutes(
  app: FastifyInstance,
  deps: SettingsRoutesDeps,
): Promise<void> {
  const { config, requireAuth, hermesHttp, logger } = deps;
  const cache = new VisionCatalogCache(config, logger);

  app.get("/settings/vision/providers", { preHandler: requireAuth }, async (_req, reply) => {
    const cat = await cache.get();
    const merged = mergeProviders(cat.providers);
    return reply.send({ providers: merged });
  });

  app.get(
    "/settings/vision/suggested-models",
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = suggestedQuery.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_query" });
      const id = parsed.data.provider;
      if (id === "auto") return reply.send({ models: [] });
      const cat = await cache.get();
      const fromCache = cat.modelsByProvider.get(id) ?? [];
      const fromStatic = STATIC_SUPPLEMENT_MODELS[id] ?? [];
      // Prefer cache (live), fall through to static for OAuth/custom providers.
      const list = fromCache.length > 0 ? fromCache : [...fromStatic];
      return reply.send({ models: list });
    },
  );

  app.get("/settings/vision", { preHandler: requireAuth }, async (_req, reply) => {
    const cfg = await hermesHttp.getConfig();
    const vision = readVisionBlock(cfg);
    const provider = String(vision["provider"] ?? "auto");
    return reply.send({
      provider,
      model: stringOr(vision["model"], ""),
      baseUrl: stringOr(vision["base_url"], ""),
      apiKey: vision["api_key"] ? "***" : "",
      timeoutS: numberOr(vision["timeout"], 120),
      explicitOverride: provider !== "auto" && provider !== "",
    });
  });

  app.put("/settings/vision", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = visionUpdateBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    }
    const cat = await cache.get();
    const knownIds = new Set([
      ...cat.providers.map((p) => p.id),
      ...STATIC_SUPPLEMENTS.map((p) => p.id),
    ]);
    if (!knownIds.has(parsed.data.provider)) {
      return reply.code(400).send({ error: "unknown_provider", provider: parsed.data.provider });
    }
    if (parsed.data.provider === "custom" && !parsed.data.baseUrl) {
      return reply.code(400).send({ error: "base_url_required_for_custom" });
    }

    const cfg = await hermesHttp.getConfig();
    const aux = ensureObject(cfg, "auxiliary");
    const vision = ensureObject(aux, "vision");

    vision["provider"] = parsed.data.provider;
    vision["model"] = parsed.data.model;
    vision["base_url"] = parsed.data.baseUrl;
    if (parsed.data.apiKey && parsed.data.apiKey !== "***") {
      vision["api_key"] = parsed.data.apiKey;
    }
    vision["timeout"] = parsed.data.timeoutS;

    try {
      await hermesHttp.putConfig(cfg);
    } catch (err) {
      logger.error({ err }, "failed to update Hermes config for vision");
      return reply.code(502).send({ error: "upstream_config_write_failed" });
    }

    return reply.send({
      provider: parsed.data.provider,
      model: parsed.data.model,
      baseUrl: parsed.data.baseUrl,
      apiKey: vision["api_key"] ? "***" : "",
      timeoutS: parsed.data.timeoutS,
      explicitOverride: parsed.data.provider !== "auto",
    });
  });
}

class VisionCatalogCache {
  private cached: VisionCatalog | null = null;
  private inflight: Promise<VisionCatalog> | null = null;

  constructor(private readonly config: AppConfig, private readonly log: AppLogger) {}

  async get(): Promise<VisionCatalog> {
    if (this.cached && Date.now() - this.cached.loadedAt < CATALOG_TTL_MS) {
      return this.cached;
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.loadFresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async loadFresh(): Promise<VisionCatalog> {
    const home = this.config.HERMES_HOME;
    if (!home) {
      this.log.debug("HERMES_HOME unset — using fallback vision catalog");
      this.cached = { ...FALLBACK_CATALOG, loadedAt: Date.now() };
      return this.cached;
    }
    const cachePath = path.join(home, "models_dev_cache.json");
    try {
      const text = await fs.readFile(cachePath, "utf8");
      const data = JSON.parse(text) as unknown;
      const parsed = parseModelsDevCache(data);
      this.cached = { ...parsed, loadedAt: Date.now() };
      this.log.debug(
        { providers: parsed.providers.length, totalModels: countModels(parsed) },
        "vision catalog loaded from models.dev cache",
      );
      return this.cached;
    } catch (err) {
      this.log.warn({ err, cachePath }, "models.dev cache unavailable — using fallback catalog");
      this.cached = { ...FALLBACK_CATALOG, loadedAt: Date.now() };
      return this.cached;
    }
  }
}

function parseModelsDevCache(raw: unknown): Omit<VisionCatalog, "loadedAt"> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { providers: [], modelsByProvider: new Map() };
  }
  const providers: VisionProvider[] = [];
  const modelsByProvider = new Map<string, string[]>();
  for (const [providerId, providerVal] of Object.entries(raw as Record<string, unknown>)) {
    if (!providerVal || typeof providerVal !== "object") continue;
    const prov = providerVal as Record<string, unknown>;
    const models = prov["models"];
    if (!models || typeof models !== "object" || Array.isArray(models)) continue;

    const visionModels: string[] = [];
    for (const [modelId, modelVal] of Object.entries(models as Record<string, unknown>)) {
      if (!modelVal || typeof modelVal !== "object") continue;
      const m = modelVal as Record<string, unknown>;
      const modalities = m["modalities"];
      if (!modalities || typeof modalities !== "object") continue;
      const inputs = (modalities as Record<string, unknown>)["input"];
      if (!Array.isArray(inputs)) continue;
      if (!inputs.includes("image")) continue;
      visionModels.push(modelId);
    }
    if (visionModels.length === 0) continue;

    visionModels.sort();
    modelsByProvider.set(providerId, visionModels);

    const env = prov["env"];
    const envKey = Array.isArray(env) && typeof env[0] === "string" ? env[0] : undefined;
    const labelFromCache = typeof prov["name"] === "string" ? prov["name"] : null;
    providers.push({
      id: providerId,
      label: PRETTY_LABELS[providerId] ?? labelFromCache ?? toTitle(providerId),
      ...(envKey ? { envKey } : {}),
    });
  }
  providers.sort((a, b) => a.label.localeCompare(b.label));
  return { providers, modelsByProvider };
}

function mergeProviders(dynamic: ReadonlyArray<VisionProvider>): VisionProvider[] {
  // Static supplements first (auto + custom + nous + codex), then sorted dynamic.
  const seen = new Set(STATIC_SUPPLEMENTS.map((p) => p.id));
  const merged: VisionProvider[] = [...STATIC_SUPPLEMENTS];
  for (const p of dynamic) {
    if (seen.has(p.id)) continue;
    merged.push(p);
    seen.add(p.id);
  }
  return merged;
}

function readVisionBlock(cfg: Record<string, unknown>): Record<string, unknown> {
  const aux = cfg["auxiliary"];
  if (!aux || typeof aux !== "object") return {};
  const vision = (aux as Record<string, unknown>)["vision"];
  if (!vision || typeof vision !== "object") return {};
  return vision as Record<string, unknown>;
}

function ensureObject(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const cur = parent[key];
  if (cur && typeof cur === "object" && !Array.isArray(cur)) {
    return cur as Record<string, unknown>;
  }
  const fresh: Record<string, unknown> = {};
  parent[key] = fresh;
  return fresh;
}

function stringOr(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function toTitle(s: string): string {
  return s
    .split(/[-_]/)
    .map((p) => (p.length === 0 ? p : p[0]!.toUpperCase() + p.slice(1)))
    .join(" ");
}

function countModels(cat: Omit<VisionCatalog, "loadedAt">): number {
  let n = 0;
  for (const list of cat.modelsByProvider.values()) n += list.length;
  return n;
}
