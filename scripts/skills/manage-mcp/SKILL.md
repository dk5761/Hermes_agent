---
name: manage-mcp
description: "Add, remove, configure, list MCP servers in Hermes config + make new tools visible to the running agent."
version: 1.0.0
author: hermes-app
license: MIT
metadata:
  hermes:
    tags: [MCP, Tools, Configuration]
    related_skills: [native-mcp]
---

# Manage MCP Servers

Use this skill when the user asks to add, install, register, configure, or remove an MCP server. The user just describes what they want ("add the GitHub MCP"); you handle the four steps below.

## Workflow when adding a new MCP server

Hermes' `hermes mcp add` registers the server config but does NOT wire it into `platform_toolsets`. Without that wire, the agent never sees the tools — this is the most common pitfall. Always do all four steps.

### 1. Register the server

Pick the correct invocation based on the user's request:

```bash
# Most common: npx-based community MCP
hermes mcp add <name> --command npx --args -y <package-spec>

# With env vars (auth tokens etc.):
hermes mcp add <name> --command npx --args -y <package-spec> --env KEY=VALUE

# Binary command:
hermes mcp add <name> --command /abs/path/to/binary --args arg1 arg2

# HTTP/SSE remote MCP:
hermes mcp add <name> --url https://example.com/mcp --auth header
```

Examples:
- `hermes mcp add github --command npx --args -y @modelcontextprotocol/server-github --env GITHUB_PERSONAL_ACCESS_TOKEN=ghp_...`
- `hermes mcp add slack --command npx --args -y @modelcontextprotocol/server-slack --env SLACK_BOT_TOKEN=xoxb-...`
- `hermes mcp add postgres --command npx --args -y @modelcontextprotocol/server-postgres postgresql://localhost/mydb`

### 2. Wire the toolset entry

After `mcp add`, edit `~/.hermes/config.yaml` to add `mcp-<name>` to the platform_toolsets the user uses (cli + tui + api_server cover all current paths):

```bash
python3 - <<'PY'
NAME = "mcp-<replace-with-server-name>"   # ← REPLACE
from ruamel.yaml import YAML
from pathlib import Path
yaml = YAML(); yaml.preserve_quotes = True; yaml.width = 4096
yaml.indent(mapping=2, sequence=2, offset=0)
p = Path("/root/.hermes/config.yaml")
cfg = yaml.load(p)
pt = cfg.setdefault("platform_toolsets", {})
for plat in ["cli", "tui", "api_server"]:
    lst = pt.setdefault(plat, [])
    if NAME not in lst:
        lst.append(NAME)
yaml.dump(cfg, p.open("w"))
print(f"Added {NAME} to platform_toolsets.cli/tui/api_server")
PY
```

Replace `mcp-<replace-with-server-name>` with the actual entry — it must match the server name from step 1, prefixed with `mcp-`.

### 3. Reload + verify

Tell the user to send `/reload-mcp` in any chat. After reload:

```bash
hermes mcp list                       # confirm new server is in the list
hermes mcp test <name>                # smoke-test connection + tools/list
```

If `hermes mcp test` succeeds, the tools will be available to the agent on next message in any chat (including existing ones — `/reload-mcp` clears the session cache).

### 4. Confirm to the user

Tell the user: "Added <name> MCP. Send `/reload-mcp` to make tools visible in this chat. New chats will see them automatically."

## Workflow for removing an MCP server

```bash
hermes mcp remove <name>

# Strip from toolsets too:
python3 - <<'PY'
NAME = "mcp-<replace-with-server-name>"
from ruamel.yaml import YAML
from pathlib import Path
yaml = YAML(); yaml.preserve_quotes = True; yaml.width = 4096
yaml.indent(mapping=2, sequence=2, offset=0)
p = Path("/root/.hermes/config.yaml")
cfg = yaml.load(p)
pt = cfg.get("platform_toolsets") or {}
for plat in ["cli", "tui", "api_server"]:
    lst = pt.get(plat) or []
    if NAME in lst:
        lst.remove(NAME)
yaml.dump(cfg, p.open("w"))
PY
```

Then `/reload-mcp` to drop the connection.

## Workflow for listing / inspecting

```bash
hermes mcp list                       # all servers + status
hermes mcp test <name>                # connect + list_tools for one server
hermes config show platform_toolsets  # which toolsets are wired per platform
```

## Common pitfalls — do not skip steps

1. **`hermes mcp add` alone is not enough.** Without step 2 (toolset wiring), `hermes mcp list` will show the server but the agent will say "I don't have access to mcp-<name> toolset." Always do step 2.

2. **Don't restart hermes-dashboard** to pick up new MCPs. `/reload-mcp` is enough — restart is only needed if you've changed something at config-version level.

3. **Existing chats**: `/reload-mcp` refreshes them too (project patches clear the session cache on reload). New chats pick up changes automatically.

4. **After `hermes update`** runs (which can revert config and source patches), run `sudo bash /root/repos/Hermes_agent/scripts/post-hermes-update.sh` to re-apply everything.

## Don't use this skill for

- **iOS-specific tools** (Calendar/Reminders/Notifications/Shortcuts) — those are already part of `mcp-ios-tools`, which routes to the user's mobile app via the gateway.
- **Reloading skills** — that's `/reload-skills` (different command, different mechanism).
- **Hermes-bundled skills** like `obsidian` — those are in the agent's skill catalog; they don't go through MCP.
