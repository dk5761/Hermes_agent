/**
 * Conversation export — serializes chat_history rows to markdown or JSON,
 * writes to the OS cache, and triggers the system share sheet.
 *
 * Markdown is opinionated/lossy (assistant text + reasoning + tool calls
 * formatted for human reading). JSON is the raw HistoryRow[] payload plus a
 * thin session metadata header — round-trippable.
 */
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";

import type { HistoryRow, SessionDto } from "@/api/types";

export type ExportFormat = "markdown" | "json";

function pickStr(p: Record<string, unknown>, key: string): string {
  const v = p[key];
  return typeof v === "string" ? v : "";
}

function fmtTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

function safeFilenameSlug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "chat"
  );
}

export function buildMarkdown(session: SessionDto, rows: HistoryRow[]): string {
  const lines: string[] = [];
  lines.push(`# ${session.title || "Chat"}`);
  lines.push("");
  lines.push(`*Session id:* \`${session.id}\``);
  lines.push(`*Exported:* ${new Date().toISOString()}`);
  lines.push(`*Created:* ${fmtTime(session.createdAt)}`);
  lines.push(`*Updated:* ${fmtTime(session.updatedAt)}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const r of rows) {
    const ts = fmtTime(r.createdAt);
    switch (r.kind) {
      case "user.message": {
        const text = pickStr(r.payload, "text");
        if (!text) continue;
        lines.push(`## You — ${ts}`);
        lines.push("");
        lines.push(text);
        lines.push("");
        break;
      }
      case "assistant.message": {
        const text = pickStr(r.payload, "text");
        const reasoning =
          pickStr(r.payload, "reasoning") || pickStr(r.payload, "reasoning_content");
        if (!text && !reasoning) continue;
        lines.push(`## Assistant — ${ts}`);
        lines.push("");
        if (text) {
          lines.push(text);
          lines.push("");
        }
        if (reasoning && reasoning !== text) {
          lines.push("> **Reasoning**");
          for (const ln of reasoning.split("\n")) {
            lines.push(`> ${ln}`);
          }
          lines.push("");
        }
        break;
      }
      case "reasoning": {
        const text = pickStr(r.payload, "text");
        if (!text) continue;
        lines.push(`### Thinking — ${ts}`);
        lines.push("");
        for (const ln of text.split("\n")) {
          lines.push(`> ${ln}`);
        }
        lines.push("");
        break;
      }
      case "tool.call": {
        const name = pickStr(r.payload, "name") || "tool";
        const args =
          pickStr(r.payload, "args") ||
          pickStr(r.payload, "command") ||
          pickStr(r.payload, "input") ||
          pickStr(r.payload, "path") ||
          pickStr(r.payload, "query");
        const summary =
          pickStr(r.payload, "summary") ||
          pickStr(r.payload, "output_preview") ||
          pickStr(r.payload, "preview");
        lines.push(`### Tool · \`${name}\` — ${ts}`);
        if (args) {
          lines.push("");
          lines.push("```");
          lines.push(args);
          lines.push("```");
        }
        if (summary) {
          lines.push("");
          lines.push(summary);
        }
        lines.push("");
        break;
      }
      case "approval.request":
      case "clarify.request":
      case "sudo.request":
      case "secret.request": {
        const prompt =
          pickStr(r.payload, "prompt") ||
          pickStr(r.payload, "question") ||
          pickStr(r.payload, "command") ||
          r.kind;
        lines.push(`### ${r.kind} — ${ts}`);
        lines.push("");
        lines.push(`> ${prompt}`);
        lines.push("");
        break;
      }
      case "error": {
        const msg = pickStr(r.payload, "message") || pickStr(r.payload, "error");
        lines.push(`### Error — ${ts}`);
        lines.push("");
        lines.push(`> ${msg}`);
        lines.push("");
        break;
      }
    }
  }
  return lines.join("\n");
}

export function buildJson(session: SessionDto, rows: HistoryRow[]): string {
  return JSON.stringify(
    {
      session: {
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        archived: session.archived,
      },
      exportedAt: new Date().toISOString(),
      rows,
    },
    null,
    2,
  );
}

export async function exportChat(
  session: SessionDto,
  rows: HistoryRow[],
  format: ExportFormat,
): Promise<void> {
  const isMd = format === "markdown";
  const ext = isMd ? "md" : "json";
  const mime = isMd ? "text/markdown" : "application/json";
  const slug = safeFilenameSlug(session.title);
  const filename = `hermes-${slug}-${session.id.slice(0, 8)}.${ext}`;
  const content = isMd ? buildMarkdown(session, rows) : buildJson(session, rows);

  const file = new File(Paths.cache, filename);
  if (file.exists) file.delete();
  file.create();
  file.write(content);

  const available = await Sharing.isAvailableAsync();
  if (!available) {
    throw new Error("Sharing not available on this device");
  }
  await Sharing.shareAsync(file.uri, {
    mimeType: mime,
    dialogTitle: `Export · ${session.title || "Chat"}`,
    UTI: isMd ? "net.daringfireball.markdown" : "public.json",
  });
}
