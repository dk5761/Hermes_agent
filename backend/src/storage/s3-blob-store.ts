// S3-compatible BlobStore (AWS S3, MinIO, any S3-compatible endpoint).
// Signed URLs use AWS presigned URLs (absolute), not the gateway HMAC scheme.
// TODO(phase-7): wire SSE-S3 / SSE-KMS knobs (ServerSideEncryption, SSEKMSKeyId)
// once VPS deployment story lands.

import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { AppLogger } from "../logger.js";
import type {
  BlobStore,
  DeleteObjectInput,
  GetObjectInput,
  MaterializeLocalFileInput,
  PutObjectInput,
  SignedUrlInput,
} from "./blob-store.js";
import type { MaterializeCache } from "./cache.js";

export interface S3BlobStoreConfig {
  client: S3Client;
  bucket: string;
  cache: MaterializeCache;
  logger: AppLogger;
}

interface S3LikeError {
  name?: string;
  Code?: string;
  $metadata?: { httpStatusCode?: number };
  message?: string;
}

export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly cache: MaterializeCache;
  private readonly logger: AppLogger;

  constructor(config: S3BlobStoreConfig) {
    this.client = config.client;
    this.bucket = config.bucket;
    this.cache = config.cache;
    this.logger = config.logger;
  }

  getBucket(): string {
    return this.bucket;
  }

  async putObject(input: PutObjectInput): Promise<void> {
    // AWS SDK's PutObject Body typing expects Buffer | Uint8Array | string | Readable | Blob.
    // Our interface allows the broader NodeJS.ReadableStream; coerce non-Readable streams via Readable.from.
    const body: Buffer | Readable = Buffer.isBuffer(input.body)
      ? input.body
      : input.body instanceof Readable
        ? input.body
        : Readable.from(input.body);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: input.key,
          Body: body,
          ContentType: input.mimeType,
        }),
      );
    } catch (err) {
      const e = err as S3LikeError;
      if (isNoSuchBucket(e)) {
        this.logger.error(
          { bucket: this.bucket, key: input.key },
          "s3 putObject failed: bucket does not exist; operator must pre-create",
        );
      }
      throw err;
    }
  }

  async getObject(input: GetObjectInput): Promise<NodeJS.ReadableStream> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: input.key }),
    );
    const body = res.Body;
    // AWS SDK v3 returns Readable in Node, web ReadableStream in browser.
    // We're Node-only; assert and surface a clear error otherwise.
    if (!body || !(body instanceof Readable)) {
      throw new Error(
        `s3 getObject: expected Node Readable body for key=${input.key}, got ${typeof body}`,
      );
    }
    return body;
  }

  async getSignedReadUrl(input: SignedUrlInput): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: input.key }),
      { expiresIn: input.expiresInSeconds },
    );
  }

  async deleteObject(input: DeleteObjectInput): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: input.key }),
      );
    } catch (err) {
      // S3 returns 204 even for missing keys; some impls (older MinIO) raise NoSuchKey.
      // Tolerate that specific case.
      if (isNoSuchKey(err as S3LikeError)) return;
      throw err;
    }
  }

  async materializeLocalFile(input: MaterializeLocalFileInput): Promise<string> {
    return this.cache.ensure(input.key, async (partial) => {
      const stream = await this.getObject({ key: input.key });
      const writeStream = fs.createWriteStream(partial);
      await pipeline(stream, writeStream);
    });
  }
}

function isNoSuchBucket(err: S3LikeError): boolean {
  return err?.name === "NoSuchBucket" || err?.Code === "NoSuchBucket";
}

function isNoSuchKey(err: S3LikeError): boolean {
  return (
    err?.name === "NoSuchKey" ||
    err?.Code === "NoSuchKey" ||
    err?.$metadata?.httpStatusCode === 404
  );
}
