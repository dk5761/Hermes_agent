import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import type { HermesHttpClient } from "../hermes/http-client.js";
import type { AppLogger } from "../logger.js";

export interface SettingsRoutesDeps {
  requireAuth: preHandlerHookHandler;
  hermesHttp: HermesHttpClient;
  logger: AppLogger;
}

const PROVIDERS: ReadonlyArray<{
  id: string;
  label: string;
  envKey?: string;
  needsBaseUrl?: boolean;
  hint?: string;
}> = [
  { id: "auto", label: "Automatic (resolve from chain)", hint: "Hermes picks the first provider with a key set" },
  { id: "openrouter", label: "OpenRouter", envKey: "OPENROUTER_API_KEY" },
  { id: "anthropic", label: "Anthropic", envKey: "ANTHROPIC_API_KEY" },
  { id: "openai", label: "OpenAI", envKey: "OPENAI_API_KEY" },
  { id: "nous", label: "Nous Portal" },
  { id: "codex", label: "Codex (gpt-5.3-codex via OAuth)" },
  { id: "custom", label: "Custom (OpenAI-compatible)", needsBaseUrl: true, hint: "Local Pixtral / Qwen-VL / LLaVA via vLLM, Ollama, etc." },
];

// Curated vision-capable models per provider. Keep terse — users can also
// type any slug they want in the model field.
const SUGGESTED_MODELS: Record<string, ReadonlyArray<string>> = {
  openrouter: [
    "anthropic/claude-sonnet-4-5",
    "anthropic/claude-opus-4-5",
    "openai/gpt-4o",
    "openai/gpt-4o-mini",
    "google/gemini-2.5-pro",
    "google/gemini-2.5-flash",
    "qwen/qwen-2.5-vl-72b-instruct",
    "mistralai/pixtral-12b",
  ],
  anthropic: ["claude-sonnet-4-5", "claude-opus-4-5", "claude-haiku-4-5"],
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
  nous: ["hermes-vision"],
  codex: ["gpt-5.3-codex"],
  custom: ["pixtral-12b", "qwen2.5-vl-7b-instruct", "llava-next-7b"],
  auto: [],
};

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
  const { requireAuth, hermesHttp, logger } = deps;

  app.get("/settings/vision/providers", { preHandler: requireAuth }, async (_req, reply) => {
    return reply.send({ providers: PROVIDERS });
  });

  app.get(
    "/settings/vision/suggested-models",
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = suggestedQuery.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_query" });
      const list = SUGGESTED_MODELS[parsed.data.provider] ?? [];
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
    const knownIds = new Set(PROVIDERS.map((p) => p.id));
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
    // "***" is the redacted sentinel from GET — treat as "leave unchanged".
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
