import type { MemoryConfig } from "../types.js";
import type { MemoryObjectStore } from "./memory-object-store.js";
import { LocalMemoryObjectStore } from "./memory-object-store.js";
import { S3MemoryObjectStore } from "./s3-memory-object-store.js";

export function joinS3Path(...segments: string[]): string {
  return segments
    .map((segment) => segment.trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
}

export function createMemoryObjectStore(config: MemoryConfig, localDir: string, remotePath: string): MemoryObjectStore {
  if (config.storage?.backend !== "s3" || !config.storage.s3) {
    return new LocalMemoryObjectStore(localDir);
  }

  return new S3MemoryObjectStore({
    endpoint: config.storage.s3.endpoint,
    accessKey: config.storage.s3.accessKey,
    secretKey: config.storage.s3.secretKey,
    bucket: config.storage.s3.bucket,
    path: joinS3Path(config.storage.s3.path, remotePath),
    forcePathStyle: config.storage.s3.forcePathStyle,
    localCache: new LocalMemoryObjectStore(localDir),
  });
}
