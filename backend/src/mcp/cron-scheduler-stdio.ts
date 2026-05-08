// cron-scheduler-stdio.ts — MCP stdio server for the schedule_chat_task tool.
//
// Spawned by Hermes per session. Reads MCP JSON-RPC frames on stdin,
// dispatches the single tool to POST /internal/cron-scheduler/create on the
// gateway, writes results to stdout. All logs to stderr (captured by Hermes).
//
// Required env vars (loaded via spawn-cron-scheduler-mcp.sh from $HERMES_HOME/.env):
//   GATEWAY_URL      e.g. http://127.0.0.1:8080
//   IOS_MCP_TOKEN    shared loopback bearer (matches gateway IOS_MCP_TOKEN)
//   IOS_MCP_USER_ID  UUID of the mobile user this MCP session belongs to
//
// We deliberately reuse IOS_MCP_TOKEN / IOS_MCP_USER_ID — they're already
// established as the "loopback MCP child" credentials and a single shared
// token is the correct trust model for a single-user app.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

const missingVars = (
  ["GATEWAY_URL", "IOS_MCP_TOKEN", "IOS_MCP_USER_ID"] as const
).filter((v) => !process.env[v]);
if (missingVars.length > 0) {
  process.stderr.write(
    `[cron-scheduler-stdio] FATAL: missing env vars: ${missingVars.join(", ")}\n`,
  );
  process.exit(1);
}

const gatewayUrl = process.env["GATEWAY_URL"] as string;
const mcpToken = process.env["IOS_MCP_TOKEN"] as string;
const userId = process.env["IOS_MCP_USER_ID"] as string;

const TOOLS: Tool[] = [
  {
    name: "schedule_chat_task",
    description:
      "Schedule a recurring AI task. Each fire runs the agent against the given prompt and routes the output to the user's chosen destination. Always specify output_target — if you don't know which, ask the user with a clarify-style question whether to use a dedicated inbox (default; recommended for ongoing tasks the user wants to revisit) or to put output in the current chat. Use this tool instead of cron_create when the user asks to schedule something AI-driven.",
    inputSchema: {
      type: "object",
      required: ["name", "cron", "prompt", "output_target"],
      properties: {
        name: {
          type: "string",
          description:
            "Short label shown in the Cron tab (e.g. 'Daily morning summary'). Max 120 chars.",
        },
        cron: {
          type: "string",
          description:
            "Standard 5-field cron expression in UTC. Examples: '0 9 * * *' (daily 09:00 UTC), '*/15 * * * *' (every 15 minutes).",
        },
        prompt: {
          type: "string",
          description:
            "What the agent should run on each fire. Self-contained — the agent's history at fire-time is the cron's bound session, not the chat the cron was created from.",
        },
        output_target: {
          type: "object",
          description:
            "Where the cron's output should be persisted. Default 'inbox' is recommended for ongoing recurring tasks; choose 'current_session' only if the user explicitly wants output mixed into the current chat.",
          oneOf: [
            {
              type: "object",
              required: ["kind"],
              properties: {
                kind: {
                  type: "string",
                  const: "inbox",
                  description:
                    "Mint a new dedicated inbox session (kind='cron_inbox') visible under the Cron tab.",
                },
                inbox_name: {
                  type: "string",
                  description:
                    "Optional name for the inbox; defaults to the cron's `name`.",
                },
              },
            },
            {
              type: "object",
              required: ["kind", "app_session_id"],
              properties: {
                kind: {
                  type: "string",
                  const: "current_session",
                  description:
                    "Output goes inline into the chat the user is currently in.",
                },
                app_session_id: {
                  type: "string",
                  description:
                    "The app_session_id of the user's current chat (visible in URL/state).",
                },
              },
            },
          ],
        },
      },
    },
  },
];

interface GatewaySuccess {
  ok: true;
  result: unknown;
}
interface GatewayFailure {
  ok: false;
  error: { code: string; message: string };
}
type GatewayResponse = GatewaySuccess | GatewayFailure;

async function callGateway(
  body: Record<string, unknown>,
): Promise<GatewayResponse> {
  const res = await fetch(`${gatewayUrl}/internal/cron-scheduler/create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${mcpToken}`,
    },
    body: JSON.stringify({ user_id: userId, ...body }),
  });
  if (!res.ok) {
    return {
      ok: false,
      error: {
        code: "bridge_error",
        message: `Cron scheduler bridge unreachable (HTTP ${res.status})`,
      },
    };
  }
  return (await res.json()) as GatewayResponse;
}

const server = new Server(
  { name: "cron-scheduler", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name: toolName, arguments: rawArguments } = request.params;
  if (toolName !== "schedule_chat_task") {
    return {
      content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
      isError: true,
    };
  }

  const args =
    rawArguments != null &&
    typeof rawArguments === "object" &&
    !Array.isArray(rawArguments)
      ? (rawArguments as Record<string, unknown>)
      : {};

  let gwRes: GatewayResponse;
  try {
    gwRes = await callGateway(args);
  } catch (err) {
    process.stderr.write(
      `[cron-scheduler-stdio] fetch error: ${String(err)}\n`,
    );
    return {
      content: [
        {
          type: "text",
          text: "Cron scheduler bridge unreachable — network error",
        },
      ],
      isError: true,
    };
  }

  if (!gwRes.ok) {
    const { code, message } = gwRes.error;
    // needs_output_target is the agent's cue to ask the user; don't mark
    // isError so the agent treats the message as instructive rather than a
    // failure to surface to the user.
    const isError = code !== "needs_output_target";
    const text = isError ? `Tool failed: ${code} — ${message}` : message;
    if (isError) {
      process.stderr.write(`[cron-scheduler-stdio] tool error: ${text}\n`);
    }
    return { content: [{ type: "text", text }], isError };
  }

  return {
    content: [{ type: "text", text: JSON.stringify(gwRes.result) }],
  };
});

process.stderr.write(
  `[cron-scheduler-stdio] starting (user=${userId}, gateway=${gatewayUrl})\n`,
);
const transport = new StdioServerTransport();
await server.connect(transport);
