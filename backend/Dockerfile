# Multi-stage Dockerfile for the Hermes mobile gateway.
# Dev workflow: docker compose up — bind-mounts ./src + ./scripts so tsx watch
# hot-reloads on host edits. node_modules lives in a named volume to preserve
# the linux-built better-sqlite3 binding from being clobbered by the host.
#
# Prod workflow: docker build --target=runtime -t gateway:prod .

# Pin platform via --platform so it matches your VPS target. Default leaves
# the daemon to pick — fine for arm64 Apple Silicon AND linux/arm64 VPS.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate
WORKDIR /app

# python3 + build-essential for better-sqlite3's node-gyp fallback when no
# prebuilt binary is available; sqlite3 cli for the backup script;
# ffmpeg for voice-memo waveform peak extraction (decodes m4a → PCM float32).
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        python3 build-essential sqlite3 \
        poppler-utils tesseract-ocr tesseract-ocr-eng \
        ffmpeg \
        ca-certificates curl tini && \
    rm -rf /var/lib/apt/lists/*

# ---------- deps stage ----------
# Resolved in its own stage so layer caching survives source edits.
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ---------- runtime stage (used by `up` and `build --target=runtime`) ----------
FROM base AS runtime
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml drizzle.config.ts tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production
EXPOSE 8080

# tini reaps zombies (relevant for tsx watch + child processes if you swap to
# spawn mode of HERMES_LAUNCH_MODE down the road).
ENTRYPOINT ["/usr/bin/tini", "--"]

# Migrations run every boot — drizzle-kit is idempotent. Then start.
CMD ["sh", "-c", "pnpm db:migrate && pnpm dev"]
