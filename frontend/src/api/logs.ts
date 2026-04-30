/**
 * /logs proxy client.
 *
 * Backend gateway proxies Hermes' GET /api/logs?file=&lines=. Hermes returns
 * `{ file, lines: string[] }` where each line is a raw log string. Some lines
 * may be JSON (pino structured) — callers parse client-side as needed.
 *
 * `search` is currently filtered client-side (the gateway proxy ignores
 * unknown query params). Passing it through is harmless and future-proofs
 * if the upstream gains support.
 */
import { apiFetch } from "./client";

export type LogFile = "agent" | "errors" | "cron" | "web" | "mcp";

export interface LogsResponse {
  file: string;
  lines: string[];
}

/** Hand-rolled guard since the gateway forwards Hermes' shape unmodified. */
function asLogsResponse(raw: unknown): LogsResponse {
  if (!raw || typeof raw !== "object") return { file: "", lines: [] };
  const r = raw as Record<string, unknown>;
  const file = typeof r.file === "string" ? r.file : "";
  const lines = Array.isArray(r.lines)
    ? r.lines.filter((x): x is string => typeof x === "string")
    : [];
  return { file, lines };
}

export async function getLogs(
  file: LogFile,
  lines = 200,
  search?: string,
): Promise<LogsResponse> {
  const data = await apiFetch<unknown>("/logs", {
    query: { file, lines, ...(search ? { search } : {}) },
  });
  return asLogsResponse(data);
}
