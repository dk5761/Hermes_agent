import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type {
  BlobStore,
  DeleteObjectInput,
  GetObjectInput,
  MaterializeLocalFileInput,
  PutObjectInput,
  SignedUrlInput,
} from "./blob-store.js";
import { SignedUrlSigner } from "./signed-url.js";

export interface LocalBlobStoreConfig {
  rootDir: string;
  bucket: string;
  signedUrlSecret: string;
  signedUrlBasePath?: string;
}

export class LocalBlobStore implements BlobStore {
  private readonly rootDir: string;
  private readonly bucket: string;
  private readonly signer: SignedUrlSigner;

  constructor(config: LocalBlobStoreConfig) {
    this.rootDir = path.resolve(config.rootDir);
    this.bucket = config.bucket;
    this.signer = new SignedUrlSigner({
      secret: config.signedUrlSecret,
      ...(config.signedUrlBasePath !== undefined ? { basePath: config.signedUrlBasePath } : {}),
    });
  }

  // local provider does not enforce bucket scoping at filesystem level; bucket is metadata only.
  getBucket(): string {
    return this.bucket;
  }

  private resolvePath(key: string): string {
    const safe = path.posix.normalize(key);
    if (safe.startsWith("..") || path.isAbsolute(safe)) {
      throw new Error(`unsafe object key: ${key}`);
    }
    return path.join(this.rootDir, safe);
  }

  async putObject(input: PutObjectInput): Promise<void> {
    const dest = this.resolvePath(input.key);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    if (Buffer.isBuffer(input.body)) {
      await fsp.writeFile(dest, input.body);
      return;
    }
    const writeStream = fs.createWriteStream(dest);
    await pipeline(input.body, writeStream);
  }

  async getObject(input: GetObjectInput): Promise<NodeJS.ReadableStream> {
    const src = this.resolvePath(input.key);
    await fsp.access(src, fs.constants.R_OK);
    return fs.createReadStream(src);
  }

  async getSignedReadUrl(input: SignedUrlInput): Promise<string> {
    const built = this.signer.buildKeyUrl({
      bucket: this.bucket,
      key: input.key,
      expiresInSeconds: input.expiresInSeconds,
    });
    return built.url;
  }

  async deleteObject(input: DeleteObjectInput): Promise<void> {
    const target = this.resolvePath(input.key);
    try {
      await fsp.unlink(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }

  async materializeLocalFile(input: MaterializeLocalFileInput): Promise<string> {
    const target = this.resolvePath(input.key);
    await fsp.access(target, fs.constants.R_OK);
    return target;
  }

  verifySignature(key: string, sig: string, exp: number, now: number = Math.floor(Date.now() / 1000)): boolean {
    return this.signer.verifyKeySignature({ bucket: this.bucket, key, sig, exp }, now);
  }
}
