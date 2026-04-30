# Ops scripts

These are small, dependency-free shell scripts intended for cron on the VPS.

## One-time setup

```sh
chmod +x scripts/backup-sqlite.sh scripts/backup-blobs.sh
```

`backup-sqlite.sh` requires the `sqlite3` CLI. `backup-blobs.sh` requires `rsync`.
Both are present on a default Ubuntu/Debian server.

## Usage

`backup-sqlite.sh [db-path] [out-dir]`

Defaults: `./data/gateway.db` -> `./backups/gateway-YYYYMMDD-HHMMSS.db.gz`.

Uses SQLite's `.backup` API, which is hot-safe (won't corrupt the WAL on a
running gateway). The output is gzipped on the spot.

`backup-blobs.sh [src-dir] [out-dir]`

Defaults: `./data/blobs` -> `./backups/blobs` (rsync mirror, `--delete` so
removed blobs propagate to the backup).

Local-storage only. When `STORAGE_PROVIDER=s3` you should rely on bucket
versioning + lifecycle rules instead; this script is unnecessary.

## Suggested crontab

```cron
0 3 * * * cd /srv/hermes-mobile-gateway && ./scripts/backup-sqlite.sh
30 3 * * * cd /srv/hermes-mobile-gateway && ./scripts/backup-blobs.sh
```

Pruning of old gzipped DB snapshots is not built in; add a `find ... -mtime
+30 -delete` line if disk space matters. The Phase 7 cleanup sweeper inside
the gateway handles orphaned blobs/refresh tokens/push tokens automatically.

## Out of scope (deferred for this MVP)

- Virus scanning (clamav).
- Encryption-at-rest beyond filesystem-level disk encryption.
- Off-site backup replication. Use the host provider's snapshot feature or
  `rclone` against the `./backups` directory if needed.
