# Hermes Mobile Gateway

Phase 1 foundation. Single-user gateway for the Hermes mobile app.

## Stack

Node 22, TypeScript strict, Fastify 5, Drizzle ORM + better-sqlite3, Zod, argon2, jsonwebtoken, pino. pnpm.

No Hermes upstream client, no uploads, no WS, no S3 in this phase.

## Setup

```sh
cp .env.example .env
# edit .env: set JWT_SECRET, STORAGE_SIGNED_URL_SECRET (>= 16 chars each)
pnpm install
pnpm db:generate   # creates initial migration in src/db/migrations
pnpm db:migrate    # applies it to ./data/gateway.db
```

## Bootstrap a user

Either set `BOOTSTRAP_USERNAME` and `BOOTSTRAP_PASSWORD` in `.env` (only used when the users table is empty) and start the server, or run the seed CLI:

```sh
pnpm seed:user
```

## Run

```sh
pnpm dev      # tsx watch
pnpm build && pnpm start
pnpm typecheck
```

## Endpoints (Phase 1)

| Method | Path | Auth |
|---|---|---|
| GET  | /health      | public |
| GET  | /health/me   | bearer |
| POST | /auth/login  | public |
| POST | /auth/refresh| public |
| POST | /auth/logout | public |

`POST /auth/login` returns `{ accessToken, refreshToken, refreshTokenExpiresAt, user }`. Access token TTL = 15m. Refresh token TTL = 30d, stored as sha256 in DB. Refresh is non-rotating in MVP (TODO in `src/auth/refresh.ts`).

## Layout

```
src/
  index.ts           entry
  server.ts          buildServer(deps) — composable for tests
  config.ts          zod env validation
  logger.ts          pino
  db/                drizzle + sqlite schema (Phase 1+2 ready)
  auth/              password, jwt, refresh, middleware, bootstrap
  routes/            auth, health
  storage/           BlobStore interface, LocalBlobStore, key builder
  types/             FastifyRequest.user augmentation
scripts/seed-user.ts CLI password setter
```

## OCR for scanned PDFs

Phase 4.5 adds OCR fallback for PDFs with no embedded text layer. The gateway
shells out to two system binaries (NOT npm packages):

- `pdftoppm` from Poppler — rasterizes PDF pages to PNG.
- `tesseract` — runs OCR on each PNG.

Install:

- macOS: `brew install poppler tesseract`
- Debian/Ubuntu: `apt-get install -y poppler-utils tesseract-ocr tesseract-ocr-eng`

The toolchain is detected lazily on the first scanned PDF that arrives; if
either binary is missing the gateway logs `ocr_toolchain_missing` once and
falls back to the existing `pdf_no_text_layer` warning path. No crash.

Tunables (see `.env.example`):

- `OCR_ENABLED=false` — short-circuits the entire path.
- `OCR_MAX_PAGES=10` — hard cap on pages rasterized per PDF.
- `OCR_DPI=200` — rasterization DPI; higher is better OCR but slower.
- `OCR_TIMEOUT_MS=60000` — wallclock cap across rasterize + OCR.
- `OCR_LANGUAGES=eng` — passed to `tesseract -l`. For multi-language install
  extra packs like `tesseract-ocr-fra` and set `OCR_LANGUAGES=eng+fra`.

## Storage providers (Phase 5)

Set `STORAGE_PROVIDER=local` (default) or `STORAGE_PROVIDER=s3`. The gateway picks the implementation via `src/storage/factory.ts`. All consumer code (`routes/uploads`, `routes/blobs`, `uploads/pipeline`, `ws/attachment-bridge`) is provider-agnostic.

When `STORAGE_PROVIDER=s3`, the following env vars are required: `STORAGE_REGION`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`. Optional: `STORAGE_ENDPOINT` (set for MinIO; leave empty for real AWS), `STORAGE_FORCE_PATH_STYLE` (default `true`; set `false` for AWS prod virtual-hosted-style), `STORAGE_S3_CACHE_DIR` (default `./data/cache/materialized`).

In S3 mode the gateway does NOT auto-create the bucket. The operator must `aws s3 mb` (or `mc mb`) before first upload.

`getSignedReadUrl` returns gateway-served `/blobs/<id>?sig=&exp=` URLs in local mode, and AWS/MinIO presigned URLs (absolute) in S3 mode. The `/blobs/:blobId` route is therefore only meaningful in local mode.

### MinIO for local testing

```
docker run -d --name minio -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=minioadmin \
  -e MINIO_ROOT_PASSWORD=minioadmin \
  -v /tmp/minio:/data \
  quay.io/minio/minio server /data --console-address :9001

mc alias set local http://127.0.0.1:9000 minioadmin minioadmin
mc mb local/hermes-mobile
```

Then in `.env`: `STORAGE_PROVIDER=s3`, `STORAGE_BUCKET=hermes-mobile`, `STORAGE_REGION=us-east-1`, `STORAGE_ENDPOINT=http://127.0.0.1:9000`, `STORAGE_ACCESS_KEY_ID=minioadmin`, `STORAGE_SECRET_ACCESS_KEY=minioadmin`, `STORAGE_FORCE_PATH_STYLE=true`.

### Migrating from local to S3

Object keys are identical between providers (`{user_id}/{yyyy}/{mm}/{sha256-or-id}`). DB rows already store `object_key` only — no schema change required. Copy the bytes:

```
aws s3 sync ./data/blobs s3://hermes-mobile-prod/   # for AWS
mc mirror ./data/blobs local/hermes-mobile/          # for MinIO
```

Then flip `STORAGE_PROVIDER=s3` and restart.

## Notes / decisions

- Schema includes Phase 2+ tables (`app_sessions`, `message_meta`, `attachments`, `derived_artifacts`, `ws_events`, `push_tokens`, `cron_prefs`) so migrations stay linear. Tables are unused in Phase 1 routes.
- LocalBlobStore signed URLs return `/blobs/<encoded-key>?sig=&exp=` — the route lands in Phase 4.
- `engines.node = ">=22"`. Local dev ran on 20.20 for typecheck only; runtime should be Node 22.
- No tests yet (per spec).
