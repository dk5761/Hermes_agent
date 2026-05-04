#!/usr/bin/env python3
"""
Patch Hermes' config.yaml to ensure the MCP servers and platform_toolsets
entries this project depends on are present.

Idempotent: re-running with the same desired state is a no-op. Preserves
existing comments and formatting via ruamel.yaml round-trip.

Usage:
  scripts/patch-hermes-config.py                            # patches local docker (./data/hermes-home/config.yaml)
  scripts/patch-hermes-config.py --config /path/to/yaml     # custom path
  scripts/patch-hermes-config.py --check                    # dry-run; exit 1 if changes needed

Designed to run *on the host that owns the config*:
  - Local docker:  run from this repo, no flags. Then `docker compose restart hermes gateway`.
  - VPS:           git pull on the VPS, run with `--config /root/.hermes/config.yaml`.
                   Then `systemctl restart hermes-dashboard hermes-gateway`.

Dependency: ruamel.yaml (for round-trip + comment preservation).
  - macOS:           python3 -m pip install --user ruamel.yaml
  - Debian/Ubuntu:   apt-get install -y python3-ruamel.yaml
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

# ─── DESIRED STATE ───────────────────────────────────────────────────────────
# Edit these dicts to add/remove MCP servers + their toolset gates.
# Re-run the script after editing.

DESIRED_MCP_SERVERS: dict[str, dict] = {
    # Filesystem MCP — sandboxed at /tmp. Pure Node, no external dependencies.
    "fs": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        "timeout": 60,
        "connect_timeout": 30,
    },
    # iOS native tools (Calendar / Reminders / Notifications / Shortcuts).
    # Routes via the Fastify gateway → user's mobile app WS → EventKit.
    #
    # Required env (set in `/root/.hermes/.env` so Hermes parent process loads
    # them and spawned child inherits — Hermes does NOT do ${VAR} substitution
    # in this `env:` block, so listing them here would pass literal strings):
    #   IOS_MCP_TOKEN=<32-byte hex, must match backend/.env>
    #   IOS_MCP_USER_ID=<gateway DB user.id>
    "ios-tools": {
        "command": "node",
        "args": ["/root/repos/Hermes_agent/backend/dist/src/mcp/ios-tools-stdio.js"],
        # Only static values here. IOS_MCP_TOKEN + IOS_MCP_USER_ID inherit
        # from Hermes' parent process env. See Hermes `~/.hermes/.env`.
        "env": {
            "GATEWAY_URL": "http://127.0.0.1:8080",
        },
        "timeout": 30,
        "connect_timeout": 10,
    },
    # Add more here. Each entry needs a matching `mcp-<name>` in
    # DESIRED_PLATFORM_TOOLSETS["cli"] below or the agent won't see its tools.
    #
    # Example — lightpanda (requires bun in the runtime):
    # "lightpanda": {
    #     "command": "bunx",
    #     "args": ["@daanrongen/lightpanda-mcp"],
    #     "env": {"LIGHTPANDA_URL": "ws://localhost:9222"},
    #     "timeout": 120,
    #     "connect_timeout": 60,
    # },
}

# Per-platform list of toolsets the agent should enable. We merge — anything
# already present is preserved; entries listed here are added if missing.
DESIRED_PLATFORM_TOOLSETS: dict[str, list[str]] = {
    "cli": [
        # Built-in: bundles web/browser/terminal/file/code_execution/...
        "hermes-cli",
        # MCP-derived toolsets: one entry per server in DESIRED_MCP_SERVERS.
        "mcp-fs",
        # Bundled Hermes skill — reads/writes the vault at OBSIDIAN_VAULT_PATH.
        # Convention: agent must write only inside ${VAULT}/Hermes/ (set via
        # system prompt). Read access is unrestricted across the vault.
        "obsidian",
        # iOS native tools — phone-side bridge for Calendar/Reminders/etc.
        # Phone may be offline; tools report own availability (see MEMORY.md).
        "mcp-ios-tools",
    ],
}

# ─── implementation ──────────────────────────────────────────────────────────


def ensure_ruamel():
    """Import ruamel.yaml; print clear install instructions if missing."""
    try:
        import ruamel.yaml  # noqa: F401

        return ruamel.yaml
    except ImportError:
        print(
            "[patch] ruamel.yaml is not installed.\n"
            "        Install one of:\n"
            "          macOS:           python3 -m pip install --user ruamel.yaml\n"
            "          Debian/Ubuntu:   apt-get install -y python3-ruamel.yaml\n"
            "          Other:           pip install ruamel.yaml",
            file=sys.stderr,
        )
        sys.exit(2)


def patch(config_path: Path, *, dry_run: bool = False) -> int:
    """Apply patches to config_path. Returns the number of changes made."""
    ruamel = ensure_ruamel()
    yaml = ruamel.YAML()
    yaml.preserve_quotes = True
    yaml.width = 4096  # avoid wrapping long lines on round-trip
    yaml.indent(mapping=2, sequence=2, offset=0)

    if not config_path.exists():
        print(f"[patch] config not found: {config_path}", file=sys.stderr)
        return -1

    with config_path.open() as f:
        cfg = yaml.load(f)

    if cfg is None:
        print(f"[patch] config is empty: {config_path}", file=sys.stderr)
        return -1

    changes: list[str] = []

    # 1) mcp_servers — additive merge by server name.
    mcp = cfg.get("mcp_servers")
    if mcp is None:
        cfg["mcp_servers"] = {}
        mcp = cfg["mcp_servers"]
        changes.append("created mcp_servers")
    for name, server_cfg in DESIRED_MCP_SERVERS.items():
        if name not in mcp:
            mcp[name] = server_cfg
            changes.append(f"added mcp_servers.{name}")
        else:
            # Don't overwrite existing entries — user may have customized
            # timeouts, env vars, etc. Only add missing keys.
            for k, v in server_cfg.items():
                if k not in mcp[name]:
                    mcp[name][k] = v
                    changes.append(f"added mcp_servers.{name}.{k}")

    # 2) platform_toolsets — additive merge by platform name.
    pt = cfg.get("platform_toolsets")
    if pt is None:
        cfg["platform_toolsets"] = {}
        pt = cfg["platform_toolsets"]
        changes.append("created platform_toolsets")
    for platform, toolsets in DESIRED_PLATFORM_TOOLSETS.items():
        existing = pt.get(platform)
        if existing is None:
            pt[platform] = list(toolsets)
            changes.append(f"created platform_toolsets.{platform}")
        else:
            for ts in toolsets:
                if ts not in existing:
                    existing.append(ts)
                    changes.append(f"added platform_toolsets.{platform}.{ts}")

    if not changes:
        print(f"[patch] {config_path}: already up to date")
        return 0

    print(f"[patch] {config_path}: {len(changes)} change(s):")
    for c in changes:
        print(f"  - {c}")

    if dry_run:
        return len(changes)

    # Write atomically via a sibling file + rename.
    backup = config_path.with_suffix(config_path.suffix + ".bak")
    shutil.copy2(config_path, backup)
    print(f"[patch] backup written: {backup}")

    tmp = config_path.with_suffix(config_path.suffix + ".tmp")
    with tmp.open("w") as f:
        yaml.dump(cfg, f)
    os.replace(tmp, config_path)
    print(f"[patch] wrote {config_path}")
    return len(changes)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config",
        type=Path,
        default=None,
        help="Path to config.yaml (default: <repo>/data/hermes-home/config.yaml — the local docker mount)",
    )
    parser.add_argument("--check", action="store_true", help="Dry-run; exit 1 if changes needed")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parent.parent
    config_path = args.config or repo_root / "data/hermes-home/config.yaml"

    rc = patch(config_path, dry_run=args.check)
    if rc < 0:
        return 1
    if args.check and rc > 0:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
