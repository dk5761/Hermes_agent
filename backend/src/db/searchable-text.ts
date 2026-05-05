/**
 * searchable-text.ts
 *
 * Extracts human-readable text from a chat_history row for FTS indexing.
 * This is the canonical source of truth for what gets indexed (Approach A).
 *
 * Pure function — no DB required. Fully unit-testable.
 *
 * Observed prod payload shapes:
 *   kind=user.message       → { text: string, finalText?: string }
 *   kind=assistant.message  → { text: string }
 *   kind=reasoning          → { text: string }  — capped at 4KB (verbose reasoning blocks)
 *   kind=tool.call          → { tool_id: string, name: string, duration_s: number, ...args }
 *   kind=approval.request   → { command: string, description?: string, pattern_key?: string }
 *   kind=tool.result        → { text?: string, output?: unknown, result?: unknown }
 *   kind=clarify.request    → { text: string }
 *   kind=sudo.request       → { text: string }
 *   kind=secret.request     → { text: string }
 *   kind=error              → { text?: string, message?: string }
 *
 * Both dot-notation (user.message) and underscore (user_message) kinds are
 * normalised to dots so callers don't need to worry about the format.
 */

export const SEARCH_TEXT_MAX_BYTES = 16 * 1024; // 16 KB hard cap per row
export const SEARCH_TEXT_REASONING_MAX_BYTES = 4 * 1024; // 4 KB for reasoning blocks

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Truncate a string to at most maxBytes UTF-8 bytes.
 * Fast path for ASCII strings; falls back to TextEncoder for multibyte.
 */
function truncate(s: string, maxBytes: number): string {
  if (s.length <= maxBytes) {
    // Fast path check: for pure ASCII, length === byte count.
    // Still need to verify byte count for emoji/CJK content.
    const enc = new TextEncoder();
    const buf = enc.encode(s);
    if (buf.length <= maxBytes) return s;
    return new TextDecoder().decode(buf.slice(0, maxBytes));
  }
  const enc = new TextEncoder();
  const buf = enc.encode(s);
  if (buf.length <= maxBytes) return s;
  return new TextDecoder().decode(buf.slice(0, maxBytes));
}

/**
 * Depth-1 value walk over tool call arguments (the payload minus tool_id,
 * duration_s, and name). Produces a space-joined string of all string/number/
 * boolean scalars, plus one level into arrays (including string properties
 * of objects within arrays, e.g. todos: [{content, priority}]).
 *
 * Deliberately does NOT JSON.stringify — that would inject structural noise
 * (brackets, quotes, keys) into the FTS tokenizer and balloon the index.
 */
export function flattenToolArgs(rest: Record<string, unknown>): string {
  const out: string[] = [];
  for (const v of Object.values(rest)) {
    if (typeof v === "string") {
      out.push(v);
    } else if (typeof v === "number" || typeof v === "boolean") {
      out.push(String(v));
    } else if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === "string") {
          out.push(item);
        } else if (typeof item === "number" || typeof item === "boolean") {
          out.push(String(item));
        } else if (item !== null && typeof item === "object") {
          // Walk one level into objects within arrays
          // (e.g. todos: [{content: "buy milk", priority: "high"}])
          for (const iv of Object.values(item as Record<string, unknown>)) {
            if (typeof iv === "string") {
              out.push(iv);
            } else if (typeof iv === "number" || typeof iv === "boolean") {
              out.push(String(iv));
            }
            // Skip nested objects/arrays deeper than 2 levels
          }
        }
      }
    }
    // Skip top-level objects deeper than 1 level (rare; not worth indexing)
  }
  return out.join(" ");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract human-readable text from a chat_history row payload for FTS indexing.
 *
 * @param kind - The chat_history.kind value (dot or underscore notation)
 * @param payload - The already-parsed payload_json object (NOT a string)
 * @returns Extracted + truncated text, or null if nothing indexable
 */
export function extractSearchableText(kind: string, payload: unknown): string | null {
  if (payload === null || payload === undefined || typeof payload !== "object") {
    return null;
  }

  const p = payload as Record<string, unknown>;

  // Normalise underscore notation → dot notation (handles both "tool_call" and "tool.call")
  const k = kind.replace(/_/g, ".");

  if (k === "user.message" || k === "assistant.message") {
    // user.message carries both text (streaming buffer) and finalText (committed).
    // Prefer finalText when present and non-empty.
    const raw =
      typeof p["finalText"] === "string" && p["finalText"].length > 0
        ? p["finalText"]
        : typeof p["text"] === "string"
          ? p["text"]
          : null;
    return raw !== null ? truncate(raw, SEARCH_TEXT_MAX_BYTES) : null;
  }

  if (k === "reasoning") {
    // Reasoning blocks can be very long — hard cap at 4KB.
    const raw = typeof p["text"] === "string" ? p["text"] : null;
    return raw !== null ? truncate(raw, SEARCH_TEXT_REASONING_MAX_BYTES) : null;
  }

  if (k === "tool.call") {
    // name is the most useful search field (e.g. "calendar_create", "browser_navigate").
    // flattenToolArgs extracts remaining fields without structural JSON noise.
    const name = typeof p["name"] === "string" ? p["name"] : "";
    // Destructure out the bookkeeping fields we don't want to index.
    const { tool_id: _tid, duration_s: _dur, name: _name, ...rest } = p;
    const argStr = Object.keys(rest).length > 0 ? flattenToolArgs(rest) : "";
    const raw = [name, argStr].filter(Boolean).join(" ");
    return raw.length > 0 ? truncate(raw, SEARCH_TEXT_MAX_BYTES) : null;
  }

  if (k === "tool.result") {
    // Not seen in current prod data (tool results may be inlined into tool.call rows).
    // Index text, output, result, or content fields defensively.
    if (typeof p["text"] === "string") {
      return truncate(p["text"], SEARCH_TEXT_MAX_BYTES);
    }
    const out = p["output"] ?? p["result"] ?? p["content"];
    if (out !== undefined && out !== null) {
      return truncate(JSON.stringify(out), SEARCH_TEXT_MAX_BYTES);
    }
    return null;
  }

  if (k === "approval.request") {
    // The command and description strings are the most searchable content.
    const parts = [p["description"], p["command"]].filter(
      (x): x is string => typeof x === "string" && x.length > 0,
    );
    const raw = parts.join(" ");
    return raw.length > 0 ? truncate(raw, SEARCH_TEXT_MAX_BYTES) : null;
  }

  if (k === "clarify.request" || k === "sudo.request" || k === "secret.request") {
    const raw = typeof p["text"] === "string" ? p["text"] : null;
    return raw !== null ? truncate(raw, SEARCH_TEXT_MAX_BYTES) : null;
  }

  if (k === "error") {
    const raw =
      typeof p["text"] === "string"
        ? p["text"]
        : typeof p["message"] === "string"
          ? p["message"]
          : null;
    return raw !== null ? truncate(raw, SEARCH_TEXT_MAX_BYTES) : null;
  }

  // Unknown kind — trigger will store COALESCE('', '') in FTS; no phantom matches.
  return null;
}
