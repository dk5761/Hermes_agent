import crypto from "node:crypto";

export interface SignedUrlConfig {
  secret: string;
  basePath?: string;
}

export interface BuildSignedBlobUrlInput {
  blobId: string;
  bucket: string;
  expiresInSeconds: number;
}

export interface VerifyBlobSignatureInput {
  blobId: string;
  bucket: string;
  sig: string;
  exp: number;
}

export interface BuildSignedKeyUrlInput {
  bucket: string;
  key: string;
  expiresInSeconds: number;
}

export interface VerifyKeySignatureInput {
  bucket: string;
  key: string;
  sig: string;
  exp: number;
}

// Two flavours of HMAC: one over (bucket, blobId, exp) used by the public
// /blobs/:blobId route, and one over (bucket, key, exp) used by
// BlobStore.getSignedReadUrl() so the storage abstraction can return a URL
// without going through the DB. The route uses the blobId form (matches the
// REST contract), while internal callers can use either.
export class SignedUrlSigner {
  private readonly secret: string;
  private readonly basePath: string;

  constructor(config: SignedUrlConfig) {
    this.secret = config.secret;
    this.basePath = config.basePath ?? "/blobs";
  }

  buildBlobUrl(input: BuildSignedBlobUrlInput): { url: string; exp: number; sig: string } {
    const exp = Math.floor(Date.now() / 1000) + input.expiresInSeconds;
    const sig = this.computeBlobSig(input.bucket, input.blobId, exp);
    return {
      url: `${this.basePath}/${encodeURIComponent(input.blobId)}?sig=${sig}&exp=${exp}`,
      exp,
      sig,
    };
  }

  verifyBlobSignature(input: VerifyBlobSignatureInput, now: number = Math.floor(Date.now() / 1000)): boolean {
    if (input.exp < now) return false;
    const expected = this.computeBlobSig(input.bucket, input.blobId, input.exp);
    return timingSafeEq(expected, input.sig);
  }

  buildKeyUrl(input: BuildSignedKeyUrlInput): { url: string; exp: number; sig: string } {
    const exp = Math.floor(Date.now() / 1000) + input.expiresInSeconds;
    const sig = this.computeKeySig(input.bucket, input.key, exp);
    return {
      url: `${this.basePath}/key/${encodeURIComponent(input.key)}?sig=${sig}&exp=${exp}`,
      exp,
      sig,
    };
  }

  verifyKeySignature(input: VerifyKeySignatureInput, now: number = Math.floor(Date.now() / 1000)): boolean {
    if (input.exp < now) return false;
    const expected = this.computeKeySig(input.bucket, input.key, input.exp);
    return timingSafeEq(expected, input.sig);
  }

  private computeBlobSig(bucket: string, blobId: string, exp: number): string {
    return crypto
      .createHmac("sha256", this.secret)
      .update(`blob\n${bucket}\n${blobId}\n${exp}`)
      .digest("hex");
  }

  private computeKeySig(bucket: string, key: string, exp: number): string {
    return crypto
      .createHmac("sha256", this.secret)
      .update(`key\n${bucket}\n${key}\n${exp}`)
      .digest("hex");
  }
}

function timingSafeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
