export interface BlobRef {
  id: string;
  bucket: string;
  key: string;
  sha256: string;
  mimeType: string;
  sizeBytes: number;
  originalName?: string;
}

export interface PutObjectInput {
  key: string;
  body: Buffer | NodeJS.ReadableStream;
  mimeType: string;
}

export interface GetObjectInput {
  key: string;
}

export interface SignedUrlInput {
  key: string;
  expiresInSeconds: number;
}

export interface DeleteObjectInput {
  key: string;
}

export interface MaterializeLocalFileInput {
  key: string;
}

export interface BlobStore {
  putObject(input: PutObjectInput): Promise<void>;
  getObject(input: GetObjectInput): Promise<NodeJS.ReadableStream>;
  getSignedReadUrl(input: SignedUrlInput): Promise<string>;
  deleteObject(input: DeleteObjectInput): Promise<void>;
  materializeLocalFile(input: MaterializeLocalFileInput): Promise<string>;
}
