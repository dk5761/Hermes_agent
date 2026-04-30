/**
 * /skills proxy client (read-only).
 *
 * Hermes returns a list of skills (built-in, user-authored, or auto-saved
 * from sessions). Shape is loose — we coerce defensively.
 */
import { apiFetch } from "./client";

export type SkillSource = "built-in" | "user" | "auto" | "unknown";

export interface Skill {
  name: string;
  description: string;
  source: SkillSource;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asSource(v: unknown): SkillSource {
  const s = typeof v === "string" ? v.toLowerCase() : "";
  if (s === "built-in" || s === "builtin") return "built-in";
  if (s === "user") return "user";
  if (s === "auto" || s === "auto-saved" || s === "autosaved") return "auto";
  return "unknown";
}

function asSkills(raw: unknown): Skill[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { skills?: unknown })?.skills)
      ? (raw as { skills: unknown[] }).skills
      : Array.isArray((raw as { items?: unknown })?.items)
        ? (raw as { items: unknown[] }).items
        : [];
  return list
    .map((s) => {
      const x = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
      const name = str(x.name) ?? str(x.id) ?? "";
      const description = str(x.description) ?? str(x.desc) ?? "";
      const source = asSource(x.source ?? x.src);
      return { name, description, source };
    })
    .filter((s): s is Skill => Boolean(s.name));
}

export async function getSkills(): Promise<Skill[]> {
  const data = await apiFetch<unknown>("/skills");
  return asSkills(data);
}
