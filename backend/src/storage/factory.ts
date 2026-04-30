import { S3Client } from "@aws-sdk/client-s3";
import type { AppConfig } from "../config.js";
import type { AppLogger } from "../logger.js";
import type { BlobStore } from "./blob-store.js";
import { LocalBlobStore } from "./local-blob-store.js";
import { MaterializeCache } from "./cache.js";
import { S3BlobStore } from "./s3-blob-store.js";

export interface BuildBlobStoreDeps {
  config: AppConfig;
  logger: AppLogger;
}

export function buildBlobStore(deps: BuildBlobStoreDeps): BlobStore {
  const { config, logger } = deps;

  if (config.STORAGE_PROVIDER === "local") {
    logger.info(
      { provider: "local", bucket: config.STORAGE_BUCKET, root: config.STORAGE_LOCAL_ROOT },
      "blob store selected",
    );
    return new LocalBlobStore({
      rootDir: config.STORAGE_LOCAL_ROOT,
      bucket: config.STORAGE_BUCKET,
      signedUrlSecret: config.STORAGE_SIGNED_URL_SECRET,
    });
  }

  // s3 provider: build the client lazily here so tests can construct stores directly.
  // Credentials must be set when STORAGE_PROVIDER=s3 (config-level zod refinement enforces this).
  const accessKeyId = config.STORAGE_ACCESS_KEY_ID ?? "";
  const secretAccessKey = config.STORAGE_SECRET_ACCESS_KEY ?? "";

  const client = new S3Client({
    region: config.STORAGE_REGION ?? "us-east-1",
    ...(config.STORAGE_ENDPOINT ? { endpoint: config.STORAGE_ENDPOINT } : {}),
    forcePathStyle: config.STORAGE_FORCE_PATH_STYLE,
    credentials: { accessKeyId, secretAccessKey },
  });

  const cache = new MaterializeCache({
    rootDir: config.STORAGE_S3_CACHE_DIR,
    logger,
  });

  // Log endpoint host (not credentials) so ops can confirm the right target at boot.
  const endpointHost = safeHost(config.STORAGE_ENDPOINT);
  logger.info(
    {
      provider: "s3",
      bucket: config.STORAGE_BUCKET,
      region: config.STORAGE_REGION,
      endpoint: endpointHost,
      forcePathStyle: config.STORAGE_FORCE_PATH_STYLE,
      cacheDir: config.STORAGE_S3_CACHE_DIR,
    },
    "blob store selected",
  );

  return new S3BlobStore({
    client,
    bucket: config.STORAGE_BUCKET,
    cache,
    logger,
  });
}

function safeHost(endpoint: string | undefined): string {
  if (!endpoint) return "aws";
  try {
    return new URL(endpoint).host;
  } catch {
    return "invalid";
  }
}
