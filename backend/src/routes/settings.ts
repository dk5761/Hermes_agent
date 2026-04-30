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

// ---------------------------------------------------------------------------
// Catalog types — shared by /settings/model* and /settings/aux/* picker UIs.
// ---------------------------------------------------------------------------

interface CatalogProvider {
  id: string;
  label: string;
  envKey?: string;
  needsBaseUrl?: boolean;
  hint?: string;
}

interface CatalogModel {
  id: string;
  label: string;
  contextWindow: number | null;
  supportsVision: boolean;
  supportsTools: boolean;
  supportsReasoning: boolean;
}

interface ModelsCatalog {
  providers: CatalogProvider[];
  // All models grouped by provider (no vision-only filter).
  modelsByProvider: Map<string, CatalogModel[]>;
  // Vision-capable subset for the legacy /settings/vision picker.
  visionModelsByProvider: Map<string, string[]>;
  loadedAt: number;
}

// Providers Hermes supports that are NOT in models.dev (OAuth or BYO endpoint).
// These are always offered.
const STATIC_SUPPLEMENTS: ReadonlyArray<CatalogProvider> = [
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

const FALLBACK_PROVIDERS: ReadonlyArray<CatalogProvider> = [
  { id: "openrouter", label: "OpenRouter", envKey: "OPENROUTER_API_KEY" },
  { id: "anthropic", label: "Anthropic", envKey: "ANTHROPIC_API_KEY" },
  { id: "openai", label: "OpenAI", envKey: "OPENAI_API_KEY" },
  { id: "zai", label: "z.ai / GLM", envKey: "ZAI_API_KEY" },
  { id: "xiaomi", label: "Xiaomi MiMo", envKey: "XIAOMI_API_KEY" },
];

const FALLBACK_VISION: Record<string, ReadonlyArray<string>> = {
  openrouter: ["anthropic/claude-sonnet-4-5", "openai/gpt-4o", "google/gemini-2.5-pro"],
  anthropic: ["claude-sonnet-4-5", "claude-opus-4-5"],
  openai: ["gpt-4o", "gpt-4o-mini"],
  zai: ["glm-5v-turbo", "glm-4.5v"],
  xiaomi: ["mimo-v2.5-pro", "mimo-v2-omni"],
};

const CATALOG_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// Aux task definitions — single source of truth for what slots are pickable.
// ---------------------------------------------------------------------------

interface AuxTask {
  id: string;
  label: string;
  description: string;
}

const AUX_TASKS: ReadonlyArray<AuxTask> = [
  { id: "vision", label: "Vision", description: "Image understanding when main model is text-only" },
  { id: "web_extract", label: "Web extract", description: "Page content extraction tools" },
  { id: "compression", label: "Compression", description: "Compact long contexts before main model sees them" },
  { id: "session_search", label: "Session search", description: "Summarize FTS5 hits across past chats" },
  { id: "skills_hub", label: "Skills hub", description: "Classify which skill to load" },
  { id: "approval", label: "Approval", description: "Pre-judge destructive commands" },
];

const AUX_TASK_IDS = new Set(AUX_TASKS.map((t) => t.id));

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const auxUpdateBody = z.object({
  provider: z.string().min(1).max(40),
  model: z.string().max(200).default(""),
  baseUrl: z.string().max(500).default(""),
  apiKey: z.string().max(500).default(""),
  timeoutS: z.number().int().min(5).max(600).default(120),
});

const suggestedQuery = z.object({
  provider: z.string().min(1).max(40),
  task: z.string().min(1).max(40).optional(),
});

const modelUpdateBody = z.object({
  provider: z.string().min(1).max(40),
  model: z.string().min(1).max(200),
});

const modelListQuery = z.object({
  provider: z.string().min(1).max(40),
  filter: z.enum(["vision", "tools", "reasoning"]).optional(),
  q: z.string().max(80).optional(),
});

const auxTaskParam = z.object({ task: z.string().min(1).max(40) });

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerSettingsRoutes(
  app: FastifyInstance,
  deps: SettingsRoutesDeps,
): Promise<void> {
  const { config, requireAuth, hermesHttp, logger } = deps;
  const cache = new ModelsCatalogCache(config, logger);

  // =========================================================================
  // 1. MAIN MODEL
  // =========================================================================
  // GET /settings/model — pull /api/model/info verbatim, normalize.
  // PUT /settings/model — write config.model = { provider, name }.
  // GET /settings/model/providers — provider list with model counts.
  // GET /settings/model/list?provider=&filter=&q= — model browser.

  app.get("/settings/model", { preHandler: requireAuth }, async (_req, reply) => {
    const info = await hermesHttp.modelInfo();
    return reply.send(normalizeModelInfo(info));
  });

  app.put("/settings/model", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = modelUpdateBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    }
    const cfg = await hermesHttp.getConfig();
    // Hermes config.model can be {provider, name} or sometimes {provider, model}
    // depending on version. We write {provider, name} (canonical) but preserve
    // any existing keys we don't understand.
    const modelBlock = ensureObject(cfg, "model");
    modelBlock["provider"] = parsed.data.provider;
    modelBlock["name"] = parsed.data.model;
    // Some versions also read .model — keep them in sync to be safe.
    modelBlock["model"] = parsed.data.model;
    try {
      await hermesHttp.putConfig(cfg);
    } catch (err) {
      logger.error({ err }, "failed to update Hermes config for main model");
      return reply.code(502).send({ error: "upstream_config_write_failed" });
    }
    // Re-read /api/model/info so we return capabilities derived from the new
    // selection (which Hermes itself computes server-side).
    const info = await hermesHttp.modelInfo();
    return reply.send(normalizeModelInfo(info));
  });

  app.get(
    "/settings/model/providers",
    { preHandler: requireAuth },
    async (_req, reply) => {
      const cat = await cache.get();
      const merged = mergeProviders(cat.providers);
      const out = merged.map((p) => ({
        id: p.id,
        label: p.label,
        ...(p.envKey ? { envKey: p.envKey } : {}),
        modelCount: cat.modelsByProvider.get(p.id)?.length ?? 0,
      }));
      return reply.send({ providers: out });
    },
  );

  app.get(
    "/settings/model/list",
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = modelListQuery.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_query" });
      const cat = await cache.get();
      const list = cat.modelsByProvider.get(parsed.data.provider) ?? [];
      let filtered = list;
      if (parsed.data.filter === "vision") {
        filtered = filtered.filter((m) => m.supportsVision);
      } else if (parsed.data.filter === "tools") {
        filtered = filtered.filter((m) => m.supportsTools);
      } else if (parsed.data.filter === "reasoning") {
        filtered = filtered.filter((m) => m.supportsReasoning);
      }
      if (parsed.data.q) {
        const q = parsed.data.q.toLowerCase();
        filtered = filtered.filter(
          (m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q),
        );
      }
      // Sort by id (deterministic).
      filtered = [...filtered].sort((a, b) => a.id.localeCompare(b.id));
      return reply.send({ models: filtered });
    },
  );

  // =========================================================================
  // 2. AUX MODELS (vision / web_extract / compression / session_search /
  //                skills_hub / approval) — generalized picker.
  // =========================================================================

  app.get("/settings/aux/tasks", { preHandler: requireAuth }, async (_req, reply) => {
    return reply.send({ tasks: AUX_TASKS });
  });

  // Shared providers/suggested-models endpoints — used by aux picker UI.
  // Filters models by task: vision → image-input only; others → all models.
  app.get("/settings/aux/providers", { preHandler: requireAuth }, async (_req, reply) => {
    const cat = await cache.get();
    const merged = mergeProviders(cat.providers);
    return reply.send({ providers: merged });
  });

  app.get(
    "/settings/aux/suggested-models",
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = suggestedQuery.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_query" });
      const id = parsed.data.provider;
      if (id === "auto") return reply.send({ models: [] });
      const cat = await cache.get();
      const task = parsed.data.task ?? "";
      let list: string[];
      if (task === "vision") {
        list = [...(cat.visionModelsByProvider.get(id) ?? [])];
      } else {
        const all = cat.modelsByProvider.get(id) ?? [];
        list = all.map((m) => m.id);
      }
      if (list.length === 0) {
        list = [...(STATIC_SUPPLEMENT_MODELS[id] ?? [])];
      }
      return reply.send({ models: list });
    },
  );

  // GET /settings/aux/:task — current config for one aux slot.
  app.get(
    "/settings/aux/:task",
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = auxTaskParam.safeParse(request.params);
      if (!parsed.success || !AUX_TASK_IDS.has(parsed.data.task)) {
        return reply.code(400).send({ error: "unknown_task" });
      }
      const cfg = await hermesHttp.getConfig();
      const block = readAuxBlock(cfg, parsed.data.task);
      const provider = String(block["provider"] ?? "auto");
      return reply.send({
        provider,
        model: stringOr(block["model"], ""),
        baseUrl: stringOr(block["base_url"], ""),
        apiKey: block["api_key"] ? "***" : "",
        timeoutS: numberOr(block["timeout"], 120),
        explicitOverride: provider !== "auto" && provider !== "",
      });
    },
  );

  // PUT /settings/aux/:task — write one aux slot.
  app.put(
    "/settings/aux/:task",
    { preHandler: requireAuth },
    async (request, reply) => {
      const paramParsed = auxTaskParam.safeParse(request.params);
      if (!paramParsed.success || !AUX_TASK_IDS.has(paramParsed.data.task)) {
        return reply.code(400).send({ error: "unknown_task" });
      }
      const bodyParsed = auxUpdateBody.safeParse(request.body ?? {});
      if (!bodyParsed.success) {
        return reply.code(400).send({ error: "invalid_body", details: bodyParsed.error.flatten() });
      }
      const cat = await cache.get();
      const knownIds = new Set([
        ...cat.providers.map((p) => p.id),
        ...STATIC_SUPPLEMENTS.map((p) => p.id),
      ]);
      if (!knownIds.has(bodyParsed.data.provider)) {
        return reply.code(400).send({ error: "unknown_provider", provider: bodyParsed.data.provider });
      }
      if (bodyParsed.data.provider === "custom" && !bodyParsed.data.baseUrl) {
        return reply.code(400).send({ error: "base_url_required_for_custom" });
      }

      const cfg = await hermesHttp.getConfig();
      const aux = ensureObject(cfg, "auxiliary");
      const block = ensureObject(aux, paramParsed.data.task);

      block["provider"] = bodyParsed.data.provider;
      block["model"] = bodyParsed.data.model;
      block["base_url"] = bodyParsed.data.baseUrl;
      if (bodyParsed.data.apiKey && bodyParsed.data.apiKey !== "***") {
        block["api_key"] = bodyParsed.data.apiKey;
      }
      block["timeout"] = bodyParsed.data.timeoutS;

      try {
        await hermesHttp.putConfig(cfg);
      } catch (err) {
        logger.error({ err, task: paramParsed.data.task }, "failed to update aux config");
        return reply.code(502).send({ error: "upstream_config_write_failed" });
      }

      return reply.send({
        provider: bodyParsed.data.provider,
        model: bodyParsed.data.model,
        baseUrl: bodyParsed.data.baseUrl,
        apiKey: block["api_key"] ? "***" : "",
        timeoutS: bodyParsed.data.timeoutS,
        explicitOverride: bodyParsed.data.provider !== "auto",
      });
    },
  );

  // -------------------------------------------------------------------------
  // Legacy /settings/vision aliases — keep live frontend working.
  // -------------------------------------------------------------------------
  app.get("/settings/vision/providers", { preHandler: requireAuth }, async (_req, reply) => {
    const cat = await cache.get();
    const merged = mergeProviders(cat.providers);
    return reply.send({ providers: merged });
  });

  app.get(
    "/settings/vision/suggested-models",
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = z.object({ provider: z.string().min(1).max(40) }).safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_query" });
      const id = parsed.data.provider;
      if (id === "auto") return reply.send({ models: [] });
      const cat = await cache.get();
      const fromCache = cat.visionModelsByProvider.get(id) ?? [];
      const fromStatic = STATIC_SUPPLEMENT_MODELS[id] ?? [];
      const list = fromCache.length > 0 ? [...fromCache] : [...fromStatic];
      return reply.send({ models: list });
    },
  );

  app.get("/settings/vision", { preHandler: requireAuth }, async (_req, reply) => {
    const cfg = await hermesHttp.getConfig();
    const vision = readAuxBlock(cfg, "vision");
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
    const bodyParsed = auxUpdateBody.safeParse(request.body ?? {});
    if (!bodyParsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: bodyParsed.error.flatten() });
    }
    const cat = await cache.get();
    const knownIds = new Set([
      ...cat.providers.map((p) => p.id),
      ...STATIC_SUPPLEMENTS.map((p) => p.id),
    ]);
    if (!knownIds.has(bodyParsed.data.provider)) {
      return reply.code(400).send({ error: "unknown_provider", provider: bodyParsed.data.provider });
    }
    if (bodyParsed.data.provider === "custom" && !bodyParsed.data.baseUrl) {
      return reply.code(400).send({ error: "base_url_required_for_custom" });
    }
    const cfg = await hermesHttp.getConfig();
    const aux = ensureObject(cfg, "auxiliary");
    const vision = ensureObject(aux, "vision");
    vision["provider"] = bodyParsed.data.provider;
    vision["model"] = bodyParsed.data.model;
    vision["base_url"] = bodyParsed.data.baseUrl;
    if (bodyParsed.data.apiKey && bodyParsed.data.apiKey !== "***") {
      vision["api_key"] = bodyParsed.data.apiKey;
    }
    vision["timeout"] = bodyParsed.data.timeoutS;
    try {
      await hermesHttp.putConfig(cfg);
    } catch (err) {
      logger.error({ err }, "failed to update Hermes config for vision");
      return reply.code(502).send({ error: "upstream_config_write_failed" });
    }
    return reply.send({
      provider: bodyParsed.data.provider,
      model: bodyParsed.data.model,
      baseUrl: bodyParsed.data.baseUrl,
      apiKey: vision["api_key"] ? "***" : "",
      timeoutS: bodyParsed.data.timeoutS,
      explicitOverride: bodyParsed.data.provider !== "auto",
    });
  });

  // =========================================================================
  // 3. PROVIDER API KEYS
  // =========================================================================
  // Expanded one row per envKey. A provider with multiple env vars surfaces
  // multiple rows (e.g. AWS uses two keys).

  app.get("/settings/keys", { preHandler: requireAuth }, async (_req, reply) => {
    const cat = await cache.get();
    const envSet = await safeGetEnv(hermesHttp, logger);
    const rows: Array<{ providerId: string; label: string; envKey: string; status: "set" | "unset" }> = [];
    for (const p of cat.providers) {
      const envKeys = cat.providerEnvKeys.get(p.id) ?? (p.envKey ? [p.envKey] : []);
      for (const k of envKeys) {
        rows.push({
          providerId: p.id,
          label: p.label,
          envKey: k,
          status: envSet.has(k) ? "set" : "unset",
        });
      }
    }
    rows.sort((a, b) => a.label.localeCompare(b.label) || a.envKey.localeCompare(b.envKey));
    return reply.send({ keys: rows });
  });

  app.get("/settings/keys/:envKey", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = z.object({ envKey: z.string().min(1).max(80) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_param" });
    const cat = await cache.get();
    const owner = findEnvOwner(cat, parsed.data.envKey);
    if (!owner) return reply.code(404).send({ error: "unknown_env_key" });
    const envSet = await safeGetEnv(hermesHttp, logger);
    return reply.send({
      providerId: owner.providerId,
      label: owner.label,
      envKey: parsed.data.envKey,
      status: envSet.has(parsed.data.envKey) ? "set" : "unset",
      // lastSetAt unavailable from Hermes; surface null per contract.
      lastSetAt: null,
    });
  });

  app.put("/settings/keys/:envKey", { preHandler: requireAuth }, async (request, reply) => {
    const paramParsed = z.object({ envKey: z.string().min(1).max(80) }).safeParse(request.params);
    if (!paramParsed.success) return reply.code(400).send({ error: "invalid_param" });
    const bodyParsed = z
      .object({
        value: z
          .string()
          .min(1)
          .max(2048)
          .refine((v) => v !== "***", { message: "value must not be the placeholder ***" }),
      })
      .safeParse(request.body ?? {});
    if (!bodyParsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: bodyParsed.error.flatten() });
    }
    const cat = await cache.get();
    const owner = findEnvOwner(cat, paramParsed.data.envKey);
    if (!owner) return reply.code(404).send({ error: "unknown_env_key" });
    try {
      await hermesHttp.setEnv(paramParsed.data.envKey, bodyParsed.data.value);
    } catch (err) {
      logger.error({ err, envKey: paramParsed.data.envKey }, "failed to set env on Hermes");
      return reply.code(502).send({ error: "upstream_env_write_failed" });
    }
    return reply.send({
      providerId: owner.providerId,
      label: owner.label,
      envKey: paramParsed.data.envKey,
      status: "set" as const,
      lastSetAt: Math.floor(Date.now() / 1000),
    });
  });

  app.delete("/settings/keys/:envKey", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = z.object({ envKey: z.string().min(1).max(80) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_param" });
    const cat = await cache.get();
    const owner = findEnvOwner(cat, parsed.data.envKey);
    if (!owner) return reply.code(404).send({ error: "unknown_env_key" });
    try {
      await hermesHttp.deleteEnv(parsed.data.envKey);
    } catch (err) {
      logger.error({ err, envKey: parsed.data.envKey }, "failed to delete env on Hermes");
      return reply.code(502).send({ error: "upstream_env_delete_failed" });
    }
    return reply.code(204).send();
  });
}

// ---------------------------------------------------------------------------
// Catalog cache + parser
// ---------------------------------------------------------------------------

interface ParsedCatalog {
  providers: CatalogProvider[];
  modelsByProvider: Map<string, CatalogModel[]>;
  visionModelsByProvider: Map<string, string[]>;
  providerEnvKeys: Map<string, string[]>;
}

interface CachedCatalog extends ParsedCatalog {
  loadedAt: number;
}

class ModelsCatalogCache {
  private cached: CachedCatalog | null = null;
  private inflight: Promise<CachedCatalog> | null = null;

  constructor(private readonly config: AppConfig, private readonly log: AppLogger) {}

  async get(): Promise<CachedCatalog> {
    if (this.cached && Date.now() - this.cached.loadedAt < CATALOG_TTL_MS) {
      return this.cached;
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.loadFresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async loadFresh(): Promise<CachedCatalog> {
    const home = this.config.HERMES_HOME;
    if (!home) {
      this.log.debug("HERMES_HOME unset — using fallback catalog");
      this.cached = { ...emptyFallback(), loadedAt: Date.now() };
      return this.cached;
    }
    const cachePath = path.join(home, "models_dev_cache.json");
    try {
      const text = await fs.readFile(cachePath, "utf8");
      const data = JSON.parse(text) as unknown;
      const parsed = parseModelsDevCache(data);
      this.cached = { ...parsed, loadedAt: Date.now() };
      this.log.debug(
        {
          providers: parsed.providers.length,
          totalModels: countModels(parsed.modelsByProvider),
        },
        "models catalog loaded from models.dev cache",
      );
      return this.cached;
    } catch (err) {
      this.log.warn({ err, cachePath }, "models.dev cache unavailable — using fallback catalog");
      this.cached = { ...emptyFallback(), loadedAt: Date.now() };
      return this.cached;
    }
  }
}

function emptyFallback(): ParsedCatalog {
  const visionModelsByProvider = new Map<string, string[]>();
  for (const [k, v] of Object.entries(FALLBACK_VISION)) visionModelsByProvider.set(k, [...v]);
  const modelsByProvider = new Map<string, CatalogModel[]>();
  for (const [k, v] of Object.entries(FALLBACK_VISION)) {
    modelsByProvider.set(
      k,
      v.map((id) => ({
        id,
        label: id,
        contextWindow: null,
        supportsVision: true,
        supportsTools: true,
        supportsReasoning: false,
      })),
    );
  }
  const providerEnvKeys = new Map<string, string[]>();
  for (const p of FALLBACK_PROVIDERS) {
    if (p.envKey) providerEnvKeys.set(p.id, [p.envKey]);
  }
  return {
    providers: [...FALLBACK_PROVIDERS],
    modelsByProvider,
    visionModelsByProvider,
    providerEnvKeys,
  };
}

function parseModelsDevCache(raw: unknown): ParsedCatalog {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      providers: [],
      modelsByProvider: new Map(),
      visionModelsByProvider: new Map(),
      providerEnvKeys: new Map(),
    };
  }
  const providers: CatalogProvider[] = [];
  const modelsByProvider = new Map<string, CatalogModel[]>();
  const visionModelsByProvider = new Map<string, string[]>();
  const providerEnvKeys = new Map<string, string[]>();

  for (const [providerId, providerVal] of Object.entries(raw as Record<string, unknown>)) {
    if (!providerVal || typeof providerVal !== "object") continue;
    const prov = providerVal as Record<string, unknown>;
    const models = prov["models"];
    if (!models || typeof models !== "object" || Array.isArray(models)) continue;

    const all: CatalogModel[] = [];
    const visionIds: string[] = [];

    for (const [modelId, modelVal] of Object.entries(models as Record<string, unknown>)) {
      if (!modelVal || typeof modelVal !== "object") continue;
      const m = modelVal as Record<string, unknown>;

      const modalities = m["modalities"];
      const inputs =
        modalities && typeof modalities === "object" && !Array.isArray(modalities)
          ? (modalities as Record<string, unknown>)["input"]
          : null;
      const supportsVision =
        Array.isArray(inputs) && inputs.some((x) => x === "image" || x === "image_url");

      const supportsTools = readBool(m["tool_call"]);
      const supportsReasoning = readBool(m["reasoning"]);

      const limit = m["limit"];
      const contextWindow =
        limit && typeof limit === "object" && !Array.isArray(limit)
          ? readNumberOrNull((limit as Record<string, unknown>)["context"])
          : null;

      const labelFromName = typeof m["name"] === "string" ? m["name"] : null;
      all.push({
        id: modelId,
        label: labelFromName ?? modelId,
        contextWindow,
        supportsVision,
        supportsTools,
        supportsReasoning,
      });
      if (supportsVision) visionIds.push(modelId);
    }

    if (all.length === 0) continue;

    all.sort((a, b) => a.id.localeCompare(b.id));
    visionIds.sort();
    modelsByProvider.set(providerId, all);
    if (visionIds.length > 0) visionModelsByProvider.set(providerId, visionIds);

    const env = prov["env"];
    const envKeys = Array.isArray(env)
      ? env.filter((e): e is string => typeof e === "string")
      : [];
    if (envKeys.length > 0) providerEnvKeys.set(providerId, envKeys);

    const labelFromCache = typeof prov["name"] === "string" ? prov["name"] : null;
    const firstEnv = envKeys[0];
    providers.push({
      id: providerId,
      label: PRETTY_LABELS[providerId] ?? labelFromCache ?? toTitle(providerId),
      ...(firstEnv ? { envKey: firstEnv } : {}),
    });
  }
  providers.sort((a, b) => a.label.localeCompare(b.label));
  return { providers, modelsByProvider, visionModelsByProvider, providerEnvKeys };
}

function mergeProviders(dynamic: ReadonlyArray<CatalogProvider>): CatalogProvider[] {
  const seen = new Set(STATIC_SUPPLEMENTS.map((p) => p.id));
  const merged: CatalogProvider[] = [...STATIC_SUPPLEMENTS];
  for (const p of dynamic) {
    if (seen.has(p.id)) continue;
    merged.push(p);
    seen.add(p.id);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// /api/env parser (defensive)
// ---------------------------------------------------------------------------

async function safeGetEnv(http: HermesHttpClient, log: AppLogger): Promise<Set<string>> {
  try {
    const raw = await http.getEnv();
    return parseEnvResponse(raw);
  } catch (err) {
    log.warn({ err }, "failed to fetch env list from Hermes");
    return new Set();
  }
}

// Hermes /api/env shape varies across versions:
//   { KEY: true }                            (boolean)
//   { KEY: "***" }                           (masked string, truthy = set)
//   { KEY: { set: true } }                   (object with .set)
//   { KEY: { value: "***", set: true } }     (full)
//   { keys: { ... } }                        (wrapped)
// We accept all and produce a Set<string> of "set" keys.
function parseEnvResponse(raw: unknown): Set<string> {
  const result = new Set<string>();
  if (!raw || typeof raw !== "object") return result;
  const root = raw as Record<string, unknown>;
  // Some versions wrap under .keys or .env.
  const envObj =
    root["keys"] && typeof root["keys"] === "object" && !Array.isArray(root["keys"])
      ? (root["keys"] as Record<string, unknown>)
      : root["env"] && typeof root["env"] === "object" && !Array.isArray(root["env"])
        ? (root["env"] as Record<string, unknown>)
        : root;
  for (const [k, v] of Object.entries(envObj)) {
    if (typeof v === "boolean") {
      if (v) result.add(k);
    } else if (typeof v === "string") {
      if (v.length > 0) result.add(k);
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      const setFlag = o["set"];
      const value = o["value"];
      if (setFlag === true) result.add(k);
      else if (typeof value === "string" && value.length > 0) result.add(k);
    }
  }
  return result;
}

function findEnvOwner(
  cat: CachedCatalog,
  envKey: string,
): { providerId: string; label: string } | null {
  for (const [pid, keys] of cat.providerEnvKeys.entries()) {
    if (keys.includes(envKey)) {
      const prov = cat.providers.find((p) => p.id === pid);
      return { providerId: pid, label: prov?.label ?? pid };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface NormalizedModelInfo {
  provider: string;
  model: string;
  capabilities: {
    supports_vision: boolean;
    supports_tools: boolean;
    supports_reasoning: boolean;
    context_window: number | null;
    max_output_tokens: number | null;
  };
  contextWindow: number | null;
}

function normalizeModelInfo(raw: unknown): NormalizedModelInfo {
  const r = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {});
  const provider = stringOr(r["provider"], "");
  // Hermes returns `model` as the model name (string). Some versions also
  // include `model_name` or nest it under .model.name — handle each defensively.
  let model = "";
  const m = r["model"];
  if (typeof m === "string") model = m;
  else if (m && typeof m === "object" && !Array.isArray(m)) {
    const inner = (m as Record<string, unknown>)["name"];
    if (typeof inner === "string") model = inner;
  }
  if (!model && typeof r["model_name"] === "string") model = r["model_name"] as string;

  const caps = r["capabilities"];
  const capObj = caps && typeof caps === "object" && !Array.isArray(caps)
    ? (caps as Record<string, unknown>)
    : {};
  const supports_vision = readBool(capObj["supports_vision"]);
  const supports_tools = readBool(capObj["supports_tools"]);
  const supports_reasoning = readBool(capObj["supports_reasoning"]);
  const context_window = readNumberOrNull(capObj["context_window"]);
  const max_output_tokens = readNumberOrNull(capObj["max_output_tokens"]);
  return {
    provider,
    model,
    capabilities: {
      supports_vision,
      supports_tools,
      supports_reasoning,
      context_window,
      max_output_tokens,
    },
    contextWindow: context_window,
  };
}

function readAuxBlock(cfg: Record<string, unknown>, task: string): Record<string, unknown> {
  const aux = cfg["auxiliary"];
  if (!aux || typeof aux !== "object") return {};
  const block = (aux as Record<string, unknown>)[task];
  if (!block || typeof block !== "object") return {};
  return block as Record<string, unknown>;
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

function readNumberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function readBool(v: unknown): boolean {
  return v === true;
}

function toTitle(s: string): string {
  return s
    .split(/[-_]/)
    .map((p) => (p.length === 0 ? p : p[0]!.toUpperCase() + p.slice(1)))
    .join(" ");
}

function countModels(byProv: Map<string, CatalogModel[]>): number {
  let n = 0;
  for (const list of byProv.values()) n += list.length;
  return n;
}
