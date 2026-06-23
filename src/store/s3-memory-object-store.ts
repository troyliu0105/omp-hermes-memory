/**
 * S3-backed object store for durable memory.
 *
 * Reads/writes full Markdown objects in an S3-compatible bucket while mirroring
 * successful operations into an optional local cache. Missing remote objects fall
 * back to uploading non-empty local cache content with `IfNoneMatch: "*"`, which
 * preserves existing local memory on first S3 startup without overwriting remote data.
 */

import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3";
import {
  type MemoryObjectKey,
  type MemoryObjectReadResult,
  type MemoryObjectStore,
  StorageConflictError,
  isSafeMemoryObjectKey,
} from "./memory-object-store.js";

export interface S3MemoryObjectStoreOptions {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  path: string;
  region?: string;
  forcePathStyle?: boolean;
  localCache?: MemoryObjectStore;
}

export function resolveS3Region(endpoint: string, region?: string): string {
  const trimmedRegion = region?.trim();
  if (trimmedRegion) return trimmedRegion;

  let hostname = "";
  try {
    hostname = new URL(endpoint).hostname.toLowerCase();
  } catch {
    hostname = endpoint.toLowerCase();
  }

  return hostname.endsWith(".r2.cloudflarestorage.com") ? "auto" : "us-east-1";
}

function isMissingS3Object(error: unknown): boolean {
  return error instanceof S3ServiceException && (
    error.name === "NoSuchKey"
    || error.name === "NotFound"
    || error.$metadata?.httpStatusCode === 404
  );
}

function isConflictResponse(error: unknown): boolean {
  return error instanceof S3ServiceException && (
    error.$metadata?.httpStatusCode === 409
    || error.$metadata?.httpStatusCode === 412
  );
}

function assertSafeKey(key: MemoryObjectKey): void {
  if (!isSafeMemoryObjectKey(key)) {
    throw new Error(`Unsafe memory object key: ${JSON.stringify(key)}`);
  }
}

export class S3MemoryObjectStore implements MemoryObjectStore {
  private client: Pick<S3Client, "send">;
  private bucket: string;
  private path: string;
  private localCache?: MemoryObjectStore;

  constructor(options: S3MemoryObjectStoreOptions, client?: Pick<S3Client, "send">) {
    this.client = client ?? new S3Client({
      region: resolveS3Region(options.endpoint, options.region),
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle ?? true,
      credentials: {
        accessKeyId: options.accessKey,
        secretAccessKey: options.secretKey,
      },
    });
    this.bucket = options.bucket;
    this.path = options.path.replace(/^\/+|\/+$/g, "");
    this.localCache = options.localCache;
  }

  async ensureReady(): Promise<void> {
    await this.localCache?.ensureReady?.();
  }

  private objectKey(key: MemoryObjectKey): string {
    return this.path ? `${this.path}/${key}` : key;
  }

  async readText(key: MemoryObjectKey): Promise<MemoryObjectReadResult> {
    assertSafeKey(key);
    const objectKey = this.objectKey(key);

    let readError: unknown = null;
    try {
      const response = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
      }));
      const content = response.Body ? await response.Body.transformToString() : "";
      try {
        await this.localCache?.writeText(key, content);
      } catch {
        // Cache write failures must not mask successful S3 reads.
      }
      return { content, version: response.ETag };
    } catch (error) {
      readError = error;
    }

    let localFallback: string | null = null;
    try {
      const cached = await this.localCache?.readText(key);
      localFallback = cached?.content?.trim() ? cached.content : null;
    } catch {
      localFallback = null;
    }

    if (readError && !isMissingS3Object(readError)) {
      if (localFallback !== null) return { content: localFallback };
      throw readError;
    }

    if (localFallback === null) {
      return { content: null };
    }

    try {
      const version = await this.writeText(key, localFallback, undefined);
      return { content: localFallback, version };
    } catch (error) {
      if (!(error instanceof StorageConflictError) && !isConflictResponse(error)) throw error;
    }

    const retry = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
    }));
    const content = retry.Body ? await retry.Body.transformToString() : "";
    try {
      await this.localCache?.writeText(key, content);
    } catch {
      // Cache write failures must not mask successful S3 reads.
    }
    return { content, version: retry.ETag };
  }

  async writeText(key: MemoryObjectKey, content: string, expectedVersion?: string): Promise<string | undefined> {
    assertSafeKey(key);

    const input: PutObjectCommandInput = {
      Bucket: this.bucket,
      Key: this.objectKey(key),
      Body: content,
      ContentType: "text/markdown; charset=utf-8",
    };

    if (expectedVersion !== undefined) {
      input.IfMatch = expectedVersion;
    } else {
      input.IfNoneMatch = "*";
    }

    try {
      const response = await this.client.send(new PutObjectCommand(input));
      try {
        await this.localCache?.writeText(key, content);
      } catch {
        // Cache write failures must not mask successful S3 writes.
      }
      return response.ETag;
    } catch (error) {
      if (isConflictResponse(error)) {
        throw new StorageConflictError(`Storage conflict writing ${this.objectKey(key)}`);
      }
      throw error;
    }
  }
}
