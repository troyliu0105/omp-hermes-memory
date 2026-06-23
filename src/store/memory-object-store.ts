/**
 * Storage abstraction for durable memory.
 *
 * `MemoryStore` delegates all persistence to this interface, so the Markdown
 * parsing/dedup/snapshot logic stays identical whether backing onto local disk
 * or S3. Two concrete implementations exist:
 *   - `LocalMemoryObjectStore`  — same-directory Markdown files (the historical behavior).
 *   - `S3MemoryObjectStore`     — S3-compatible bucket with a local disk cache mirror.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MEMORY_FILE, USER_FILE } from "../constants.js";

export type MemoryObjectKey = string;

export interface MemoryObjectReadResult {
  /** Object content, or `null` when the object does not exist. */
  content: string | null;
  /** Backend-specific version token (e.g. S3 ETag) used for optimistic concurrency. */
  version?: string;
}

/**
 * Thrown by object stores when a conditional write detects a version conflict
 * (e.g. S3 409/412 or `IfMatch`/`IfNoneMatch` mismatch). `MemoryStore` catches
 * this to reload-and-retry once.
 */
export class StorageConflictError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "StorageConflictError";
  }
}

export interface MemoryObjectStore {
  readText(key: MemoryObjectKey): Promise<MemoryObjectReadResult>;
  writeText(key: MemoryObjectKey, content: string, expectedVersion?: string): Promise<string | undefined>;
  ensureReady?(): Promise<void>;
}

const SAFE_MEMORY_OBJECT_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

/**
 * True only for relative Markdown object keys without path traversal.
 * Accepts primary files (`MEMORY.md`, `USER.md`, `failures.md`) and same-directory
 * sidecar names like `y_memory.md`. Rejects absolute paths, `..`, path separators,
 * empty strings, hidden-dot names, and non-`.md` files.
 */
export function isSafeMemoryObjectKey(key: string): boolean {
  if (typeof key !== "string" || key.length === 0) return false;
  if (key !== MEMORY_FILE && key !== USER_FILE && key !== "failures.md") {
    if (!SAFE_MEMORY_OBJECT_KEY.test(key)) return false;
  }
  // Extra safety: reject any path separators or traversal even if the regex somehow matched.
  if (key.includes("/") || key.includes("\\") || key.includes("..")) return false;
  if (key.startsWith(".")) return false;
  return true;
}

function assertSafeKey(key: MemoryObjectKey): void {
  if (!isSafeMemoryObjectKey(key)) {
    throw new Error(`Unsafe memory object key: ${JSON.stringify(key)}`);
  }
}

/**
 * Local-disk object store mirroring the historical `MemoryStore` file behavior.
 * All keys resolve into `rootDir`. Missing/unreadable files read as `content: null`;
 * writes use same-directory temp file + rename (atomic, cross-device safe).
 */
export class LocalMemoryObjectStore implements MemoryObjectStore {
  constructor(private rootDir: string) {}

  async ensureReady(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
  }

  async readText(key: MemoryObjectKey): Promise<MemoryObjectReadResult> {
    assertSafeKey(key);
    try {
      const content = await fs.readFile(path.join(this.rootDir, key), "utf-8");
      return { content };
    } catch {
      return { content: null };
    }
  }

  async writeText(key: MemoryObjectKey, content: string, _expectedVersion?: string): Promise<string | undefined> {
    assertSafeKey(key);
    await fs.mkdir(this.rootDir, { recursive: true });

    const filePath = path.join(this.rootDir, key);
    const tmpDir = await fs.mkdtemp(path.join(this.rootDir, ".tmp-"));
    const tmpPath = path.join(tmpDir, "write.tmp");

    try {
      await fs.writeFile(tmpPath, content, "utf-8");
      await fs.rename(tmpPath, filePath);
    } catch (err) {
      try { await fs.unlink(tmpPath); } catch { /* ignore */ }
      throw err;
    } finally {
      try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    return undefined;
  }
}
