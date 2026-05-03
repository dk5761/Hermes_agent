#!/usr/bin/env python3
"""
Patch Hermes' config.yaml to ensure the MCP servers and platform_toolsets
entries this project depends on are present.

Idempotent: re-running with the same desired state is a no-op. Preserves
existing comments and formatting via ruamel.yaml round-trip.

Usage:
  scripts/patch-hermes-config.py
  scripts/patch-hermes-config.py --config /path/to/config.yaml
  scripts/patch-hermes-config.py --check       # dry-run, exit 1 if changes needed
  scripts/patch-hermes-config.py --vps         # patch the VPS hermes via SSH

Run after a Hermes upgrade or whenever you've changed the desired state below.
"""

from __future__ import annotations

import argparse
import importlib
import os
import shutil
import subprocess
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
    ],
}

# ─── implementation ──────────────────────────────────────────────────────────


def ensure_ruamel():
    """Import ruamel.yaml; auto-install via pip if missing."""
    try:
        return importlib.import_module("ruamel.yaml")
    except ImportError:
        print("[patch] installing ruamel.yaml...", file=sys.stderr)
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "--quiet", "--user", "ruamel.yaml"],
            stdout=subprocess.DEVNULL,
        )
        return importlib.import_module("ruamel.yaml")


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


def patch_vps() -> int:
    """SSH into the VPS, copy the config, patch locally, copy back, restart."""
    vps_host = os.environ.get("HERMES_VPS_HOST", "root@187.127.157.66")
    remote_path = "/root/.hermes/config.yaml"
    local_tmp = Path("/tmp/hermes-vps-config.yaml")

    print(f"[patch] fetching {vps_host}:{remote_path}")
    subprocess.check_call(["scp", "-q", f"{vps_host}:{remote_path}", str(local_tmp)])
    rc = patch(local_tmp)
    if rc <= 0:
        return rc
    print(f"[patch] uploading patched config back to {vps_host}")
    subprocess.check_call(["scp", "-q", str(local_tmp), f"{vps_host}:{remote_path}"])
    print("[patch] restarting hermes services on VPS")
    subprocess.check_call(
        ["ssh", vps_host, "systemctl restart hermes-dashboard hermes-gateway"]
    )
    return rc


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config",
        type=Path,
        default=None,
        help="Path to config.yaml (default: ./data/hermes-home/config.yaml relative to repo root)",
    )
    parser.add_argument("--check", action="store_true", help="Dry-run; exit 1 if changes needed")
    parser.add_argument("--vps", action="store_true", help="Patch VPS hermes via SSH")
    args = parser.parse_args()

    if args.vps:
        if args.check:
            print("--check not supported with --vps (yet)", file=sys.stderr)
            return 2
        rc = patch_vps()
        return 0 if rc >= 0 else 1

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
