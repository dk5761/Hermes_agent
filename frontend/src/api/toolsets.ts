/**
 * /tools/toolsets proxy client (read-only).
 *
 * Hermes exposes a list of toolsets registered with the agent. Shape is
 * loosely defined upstream — we coerce defensively.
 */
import { apiFetch } from "./client";

export interface Toolset {
  id: string;
  name: string;
  description: string;
  /** Number of tools in this set, when reported. */
  toolCount: number;
  /** Whether the toolset is currently loaded by the agent (from upstream). */
  enabled: boolean;
  /** Optional env-var name required to use this toolset (e.g. GITHUB_TOKEN). */
  needsEnv?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function asToolsets(raw: unknown): Toolset[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { toolsets?: unknown })?.toolsets)
      ? (raw as { toolsets: unknown[] }).toolsets
      : Array.isArray((raw as { items?: unknown })?.items)
        ? (raw as { items: unknown[] }).items
        : [];
  return list
    .map((t, i) => {
      const x = (t && typeof t === "object" ? t : {}) as Record<string, unknown>;
      const id = str(x.id) ?? str(x.name) ?? `toolset-${i}`;
      const name = str(x.name) ?? str(x.id) ?? "(unnamed)";
      const description = str(x.description) ?? str(x.hint) ?? "";
      const toolCount =
        num(x.toolCount, NaN) ||
        num(x.count, NaN) ||
        (Array.isArray(x.tools) ? x.tools.length : 0);
      const enabled = x.enabled === undefined ? true : x.enabled === true;
      const needsEnv = str(x.needsEnv) ?? str(x.need) ?? str(x.envKey);
      const ts: Toolset = { id, name, description, toolCount, enabled };
      if (needsEnv) ts.needsEnv = needsEnv;
      return ts;
    })
    .filter((t) => Boolean(t.id));
}

export async function getToolsets(): Promise<Toolset[]> {
  const data = await apiFetch<unknown>("/tools/toolsets");
  return asToolsets(data);
}
