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

# Distinct from None for "missing key" detection in scalar walks.
_SENTINEL = object()

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
    # Routes via Fastify gateway → user's mobile app WS → EventKit.
    #
    # Spawned via a bash wrapper because Hermes neither inherits parent env
    # nor expands ${VAR} placeholders in the `env:` block. The wrapper
    # sources $HERMES_HOME/.env at spawn time and execs the Node MCP server.
    #
    # Required env in `/root/.hermes/.env` (rotation: edit .env, restart):
    #   IOS_MCP_TOKEN=<32-byte hex, must match backend/.env>
    #   IOS_MCP_USER_ID=<gateway DB user.id>
    #   GATEWAY_URL=http://127.0.0.1:8080
    "ios-tools": {
        "command": "/root/repos/Hermes_agent/scripts/spawn-ios-tools-mcp.sh",
        "args": [],
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

# Scalar config keys to enforce. Each key is a dotted path. Existing values
# are OVERWRITTEN when they don't match — these are workflow defaults the
# project depends on, not user preferences. Add sparingly.
DESIRED_CONFIG_VALUES: dict[str, object] = {
    # /reload-mcp shows a "Confirm reload" prompt by default. Our mobile UI
    # doesn't render the slash-confirm flow, so the dashboard waits forever
    # for a tap that never comes and the gateway times out at 30-90s. Disable
    # the gate so reload-mcp runs immediately.
    "approvals.mcp_reload_confirm": False,
    # TTS provider — Kokoro local CPU model wired in via patch-hermes-tts-kokoro
    # + patch-hermes-tts-warmup. Multilingual, ~310 MB ONNX, ~0.3 RTF on KVM2,
    # no API key. Voice/lang/speed knobs live under tts.kokoro below.
    "tts.provider": "kokoro",
    "tts.kokoro.voice": "am_michael",
    "tts.kokoro.speed": 1.0,
    "tts.kokoro.lang": "en-us",
}

# Per-platform list of toolsets the agent should enable. We merge — anything
# already present is preserved; entries listed here are added if missing.
_CORE_TOOLSETS = [
    "hermes-cli",
    "mcp-fs",
    "obsidian",
    "mcp-ios-tools",
    # Exposes the `stt_status` introspection tool — added by patch-hermes-stt-introspect.py.
    "stt_introspect",
]
DESIRED_PLATFORM_TOOLSETS: dict[str, list[str]] = {
    # Mobile gateway sessions arrive with platform "cli" via _platform_config_key
    # (LOCAL→cli mapping in gateway/run.py).
    "cli": list(_CORE_TOOLSETS),
    # Defensive: tui and api_server are alternate paths some Hermes builds use
    # for /api/ws-style sessions. Mirroring the cli list here ensures the
    # agent always sees the same tool surface no matter which platform key
    # the Hermes session ends up with.
    "tui": list(_CORE_TOOLSETS),
    "api_server": list(_CORE_TOOLSETS),
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
    # Servers we skip because their command path doesn't exist on this host.
    # Used below to also skip the matching `mcp-<name>` toolset entry so we
    # don't leave a dangling toolset reference.
    skipped_servers: set[str] = set()

    # 1) mcp_servers — additive merge by server name.
    #
    # Environment-aware: skip an entry if its absolute `command` path doesn't
    # exist on this host. Lets the same script run against:
    #   - VPS (/root/.hermes/config.yaml + /root/repos/... wrapper exists)
    #   - Local docker (./data/hermes-home/config.yaml; VPS-only paths skipped)
    # without writing broken paths into the docker container's view.
    mcp = cfg.get("mcp_servers")
    if mcp is None:
        cfg["mcp_servers"] = {}
        mcp = cfg["mcp_servers"]
        changes.append("created mcp_servers")
    for name, server_cfg in DESIRED_MCP_SERVERS.items():
        cmd = server_cfg.get("command", "")
        # Only treat absolute paths as a presence check — relative names like
        # "node" / "npx" / "bunx" resolve via PATH at spawn time and we don't
        # want false negatives.
        if isinstance(cmd, str) and cmd.startswith("/") and not Path(cmd).exists():
            skipped_servers.add(name)
            if name not in mcp:
                print(
                    f"[patch] SKIP mcp_servers.{name}: command not found on this host: {cmd}",
                )
            else:
                print(
                    f"[patch] WARN mcp_servers.{name}: command path missing on this host "
                    f"({cmd}); leaving existing entry alone.",
                )
            continue
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

    # 2) scalar config values at dotted paths — overwrite if mismatched.
    for dotted_path, desired_value in DESIRED_CONFIG_VALUES.items():
        keys = dotted_path.split(".")
        node = cfg
        # Walk to the parent, creating intermediate dicts as needed.
        for k in keys[:-1]:
            if not isinstance(node.get(k), dict):
                node[k] = {}
                changes.append(f"created {dotted_path[: dotted_path.rfind(k) + len(k)]}")
            node = node[k]
        leaf = keys[-1]
        current = node.get(leaf, _SENTINEL)
        if current is _SENTINEL:
            node[leaf] = desired_value
            changes.append(f"set {dotted_path} = {desired_value!r}")
        elif current != desired_value:
            node[leaf] = desired_value
            changes.append(f"updated {dotted_path}: {current!r} → {desired_value!r}")

    # 3) platform_toolsets — additive merge by platform name.
    pt = cfg.get("platform_toolsets")
    if pt is None:
        cfg["platform_toolsets"] = {}
        pt = cfg["platform_toolsets"]
        changes.append("created platform_toolsets")
    for platform, toolsets in DESIRED_PLATFORM_TOOLSETS.items():
        # Filter out toolsets that reference a skipped MCP server. The naming
        # convention `mcp-<server-name>` (e.g. mcp-ios-tools → ios-tools)
        # links the two; if the server was skipped above, drop the toolset.
        eligible = [
            ts for ts in toolsets
            if not (ts.startswith("mcp-") and ts[len("mcp-"):] in skipped_servers)
        ]
        if len(eligible) != len(toolsets):
            for ts in toolsets:
                if ts not in eligible:
                    print(
                        f"[patch] SKIP platform_toolsets.{platform}.{ts}: "
                        f"references skipped server",
                    )
        existing = pt.get(platform)
        if existing is None:
            pt[platform] = list(eligible)
            if eligible:
                changes.append(f"created platform_toolsets.{platform}")
        else:
            for ts in eligible:
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
