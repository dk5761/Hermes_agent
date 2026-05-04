// ios-tools-stdio.ts — MCP stdio server for iOS native tools.
//
// Spawned by Hermes as a child process per session. Reads MCP JSON-RPC frames
// on stdin, dispatches tool calls to POST /internal/ios-tool on the gateway,
// writes results to stdout. All log output goes to stderr (captured by Hermes).
//
// Required env vars:
//   GATEWAY_URL      e.g. http://127.0.0.1:8080
//   IOS_MCP_TOKEN    shared bearer token (matches gateway IOS_MCP_TOKEN)
//   IOS_MCP_USER_ID  UUID of the mobile user whose WS session to target
//
// Hermes spawn config (Phase 6):
//   "command": "node"
//   "args": ["/path/to/backend/dist/src/mcp/ios-tools-stdio.js"]

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";

// ─── Environment validation ───────────────────────────────────────────────────

const missingVars = (["GATEWAY_URL", "IOS_MCP_TOKEN", "IOS_MCP_USER_ID"] as const).filter(
  (v) => !process.env[v],
);
if (missingVars.length > 0) {
  process.stderr.write(`[ios-tools-stdio] FATAL: missing env vars: ${missingVars.join(", ")}\n`);
  process.exit(1);
}

// Asserted non-null after the guard above.
const gatewayUrl = process.env["GATEWAY_URL"] as string;
const mcpToken = process.env["IOS_MCP_TOKEN"] as string;
const userId = process.env["IOS_MCP_USER_ID"] as string;

// ─── ISO-8601 ↔ epoch-ms helpers ─────────────────────────────────────────────

function toEpochMs(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`Invalid ISO-8601 timestamp: ${iso}`);
  return ms;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

// ─── Tool catalog ─────────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: "ios.calendar.add_event",
    description: "Create an event in the user's iCloud Calendar synced to their iPhone. Permission may be requested on first call.",
    inputSchema: {
      type: "object",
      required: ["title", "start", "end"],
      properties: {
        title: { type: "string" },
        start: { type: "string", description: "ISO-8601 timestamp" },
        end: { type: "string", description: "ISO-8601 timestamp" },
        notes: { type: "string" },
        calendar_id: { type: "string", description: "Calendar identifier — leave blank to use the default calendar" },
        all_day: { type: "boolean" },
      },
    },
  },
  {
    name: "ios.calendar.list_events",
    description: "List events from the user's iCloud Calendar within a time range.",
    inputSchema: {
      type: "object",
      required: ["start_range", "end_range"],
      properties: {
        start_range: { type: "string", description: "ISO-8601 timestamp — range start (inclusive)" },
        end_range: { type: "string", description: "ISO-8601 timestamp — range end (inclusive)" },
        calendar_ids: { type: "array", items: { type: "string" }, description: "Filter to specific calendar identifiers; omit for all" },
      },
    },
  },
  {
    name: "ios.calendar.delete_event",
    description: "Permanently delete a calendar event by its identifier.",
    inputSchema: {
      type: "object",
      required: ["event_id"],
      properties: {
        event_id: { type: "string", description: "EKEvent identifier returned by add_event or list_events" },
      },
    },
  },
  {
    name: "ios.reminders.add",
    description: "Add a reminder to the user's iOS Reminders app. Permission may be requested on first call.",
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string" },
        due_date: { type: "string", description: "ISO-8601 timestamp for when the reminder is due" },
        list_id: { type: "string", description: "Reminder list identifier. Defaults to Inbox." },
        notes: { type: "string" },
      },
    },
  },
  {
    name: "ios.reminders.list",
    description: "List reminders, optionally filtered by completion state and list.",
    inputSchema: {
      type: "object",
      required: [],
      properties: {
        filter: { type: "string", enum: ["pending", "completed", "all"], description: "Completion state filter; defaults to 'pending'" },
        list_ids: { type: "array", items: { type: "string" }, description: "Filter to specific list identifiers; omit for all" },
      },
    },
  },
  {
    name: "ios.reminders.complete",
    description: "Mark a reminder as completed.",
    inputSchema: {
      type: "object",
      required: ["reminder_id"],
      properties: {
        reminder_id: { type: "string", description: "EKReminder identifier returned by add or list" },
      },
    },
  },
  {
    name: "ios.notification.send",
    description: "Schedule a local push notification on the user's iPhone. Fires immediately if fire_at is omitted.",
    inputSchema: {
      type: "object",
      required: ["title", "body"],
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        fire_at: { type: "string", description: "ISO-8601 timestamp to deliver the notification; omit for immediate" },
      },
    },
  },
  {
    name: "ios.shortcut.run",
    description: "Run a named Apple Shortcut on the user's iPhone. Only invoke when the name clearly matches intent; never invent names.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "Exact name of the shortcut to run" },
        input: { type: "string", description: "Optional text input passed to the shortcut" },
      },
    },
  },
];

// ─── MCP ↔ native boundary translation ───────────────────────────────────────
//
// The MCP surface exposed to Hermes (and therefore to Claude) uses:
//   • snake_case field names  (e.g. start_range, calendar_id, fire_at)
//   • ISO-8601 strings        for all timestamps
//
// The native iOS module (frontend/modules/ios-tools/src/types.ts) uses:
//   • camelCase field names   (e.g. startMs, calendarId, fireAtMs)
//   • epoch-millisecond numbers for all timestamps
//
// The two transform helpers below bridge this gap.  Everything inside
// callGateway speaks native; everything outside speaks MCP.

type RawArgs = Record<string, unknown>;

type FieldMap = {
  /** MCP snake_case key → native camelCase key (applied after iso2ms) */
  inRename?: Record<string, string>;
  /** MCP keys whose ISO-8601 string values must be converted to epoch ms */
  inIso2Ms?: string[];
  /** Native camelCase key → MCP snake_case key (applied before ms2iso) */
  outRename?: Record<string, string>;
  /** Native keys whose epoch-ms number values must be converted to ISO-8601 */
  outMs2Iso?: string[];
  /** When true, transformOut maps over each element of an array result */
  outIsArray?: boolean;
};

// Per-tool translation config.  Keys absent from a map are passed through
// unchanged.  undefined / null values in args are dropped (never sent as null).
const TOOL_TRANSFORMS: Record<string, FieldMap> = {
  "ios.calendar.add_event": {
    inIso2Ms:  ["start", "end"],
    inRename:  { start: "startMs", end: "endMs", calendar_id: "calendarId", all_day: "allDay" },
    // result is { id } — no renames needed
  },

  "ios.calendar.list_events": {
    inIso2Ms:  ["start_range", "end_range"],
    inRename:  { start_range: "startMs", end_range: "endMs", calendar_ids: "calendarIds" },
    outRename: { startMs: "start", endMs: "end", calendarId: "calendar_id", calendarTitle: "calendar_title", allDay: "all_day" },
    outMs2Iso: ["start", "end"],   // applied after rename: native startMs → start → ISO string
    outIsArray: true,
  },

  "ios.calendar.delete_event": {
    inRename:  { event_id: "id" },
    // result is { ok: true } — pass-through
  },

  "ios.reminders.add": {
    inIso2Ms:  ["due_date"],
    inRename:  { due_date: "dueDateMs", list_id: "listId" },
    // result is { id } — pass-through
  },

  "ios.reminders.list": {
    inRename:  { list_ids: "listIds" },
    // filter passes through unchanged (same string value on both sides)
    outRename: { dueMs: "due", listId: "list_id", listTitle: "list_title" },
    outMs2Iso: ["due"],   // only present when the reminder has a due date
    outIsArray: true,
  },

  "ios.reminders.complete": {
    inRename:  { reminder_id: "id" },
    // result is { ok: true } — pass-through
  },

  "ios.notification.send": {
    inIso2Ms:  ["fire_at"],
    inRename:  { fire_at: "fireAtMs" },
    // result is { id } — pass-through
  },

  "ios.shortcut.run": {
    // both args (name, input) and result { ok: true } pass through as-is
  },
};

// Translate MCP args → native args.
// Order: ISO→ms conversion first, then key rename.
function transformIn(toolName: string, args: RawArgs): RawArgs {
  const cfg = TOOL_TRANSFORMS[toolName];
  if (!cfg) return args;

  let out: RawArgs = { ...args };

  // 1. ISO-8601 → epoch ms
  if (cfg.inIso2Ms) {
    for (const mcpKey of cfg.inIso2Ms) {
      const val = out[mcpKey];
      if (typeof val === "string" && val.length > 0) {
        out[mcpKey] = toEpochMs(val);
      }
    }
  }

  // 2. Key rename (snake → camel)
  if (cfg.inRename) {
    const renamed: RawArgs = {};
    for (const [k, v] of Object.entries(out)) {
      if (v === undefined || v === null) continue;  // drop absent optional fields
      const nativeKey = cfg.inRename[k] ?? k;
      renamed[nativeKey] = v;
    }
    out = renamed;
  } else {
    // Still drop undefined/null even when there's no rename map
    for (const k of Object.keys(out)) {
      if (out[k] === undefined || out[k] === null) delete out[k];
    }
  }

  return out;
}

// Translate a single native result object → MCP shape.
// Order: key rename first, then ms→ISO conversion.
function transformOutObject(cfg: FieldMap, obj: Record<string, unknown>): Record<string, unknown> {
  let out: Record<string, unknown> = { ...obj };

  // 1. Key rename (camel → snake)
  if (cfg.outRename) {
    const renamed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(out)) {
      const mcpKey = cfg.outRename[k] ?? k;
      renamed[mcpKey] = v;
    }
    out = renamed;
  }

  // 2. epoch ms → ISO-8601  (using the post-rename MCP key names)
  if (cfg.outMs2Iso) {
    for (const mcpKey of cfg.outMs2Iso) {
      const val = out[mcpKey];
      if (typeof val === "number") out[mcpKey] = toIso(val);
      // If the key is absent (e.g. optional dueMs), leave it out entirely
    }
  }

  return out;
}

// Translate native result → MCP result.
function transformOut(toolName: string, result: unknown): unknown {
  const cfg = TOOL_TRANSFORMS[toolName];
  if (!cfg || (!cfg.outRename && !cfg.outMs2Iso)) return result;

  if (cfg.outIsArray && Array.isArray(result)) {
    return result.map((item) =>
      typeof item === "object" && item !== null
        ? transformOutObject(cfg, item as Record<string, unknown>)
        : item,
    );
  }

  if (typeof result === "object" && result !== null) {
    return transformOutObject(cfg, result as Record<string, unknown>);
  }

  return result;
}

// ─── Gateway call ─────────────────────────────────────────────────────────────

interface GatewaySuccess { ok: true; result: unknown }
interface GatewayFailure { ok: false; error: { code: string; message: string } }
type GatewayResponse = GatewaySuccess | GatewayFailure;

async function callGateway(toolName: string, rawArgs: RawArgs): Promise<GatewayResponse> {
  const res = await fetch(`${gatewayUrl}/internal/ios-tool`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${mcpToken}` },
    body: JSON.stringify({ user_id: userId, tool: toolName, args: transformIn(toolName, rawArgs) }),
  });
  if (!res.ok) {
    return { ok: false, error: { code: "bridge_error", message: `iOS tools bridge unreachable (HTTP ${res.status})` } };
  }
  return (await res.json()) as GatewayResponse;
}

// ─── MCP server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: "ios-tools", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name: toolName, arguments: rawArguments } = request.params;

  if (!TOOLS.some((t) => t.name === toolName)) {
    return { content: [{ type: "text", text: `Unknown tool: ${toolName}` }], isError: true };
  }

  const args: RawArgs =
    rawArguments != null && typeof rawArguments === "object" && !Array.isArray(rawArguments)
      ? (rawArguments as RawArgs)
      : {};

  let gwRes: GatewayResponse;
  try {
    gwRes = await callGateway(toolName, args);
  } catch (err) {
    process.stderr.write(`[ios-tools-stdio] fetch error (${toolName}): ${String(err)}\n`);
    return { content: [{ type: "text", text: "iOS tools bridge unreachable — network error" }], isError: true };
  }

  if (!gwRes.ok) {
    const { code, message } = gwRes.error;
    const text = `Tool failed: ${code} — ${message}`;
    process.stderr.write(`[ios-tools-stdio] tool error (${toolName}): ${text}\n`);
    return { content: [{ type: "text", text }], isError: true };
  }

  return { content: [{ type: "text", text: JSON.stringify(transformOut(toolName, gwRes.result)) }] };
});

// ─── Start ────────────────────────────────────────────────────────────────────

process.stderr.write(`[ios-tools-stdio] starting (user=${userId}, gateway=${gatewayUrl})\n`);
const transport = new StdioServerTransport();
await server.connect(transport);
