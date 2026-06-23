import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3ServiceException,
  type S3Client,
} from "@aws-sdk/client-s3";
import { LocalMemoryObjectStore, StorageConflictError, type MemoryObjectStore } from "../../src/store/memory-object-store.js";
import { S3MemoryObjectStore } from "../../src/store/s3-memory-object-store.js";

function bodyOf(content: string) {
  return {
    async transformToString() {
      return content;
    },
  };
}

function s3Error(name: string, httpStatusCode: number): S3ServiceException {
  return new S3ServiceException({
    name,
    message: name,
    $metadata: { httpStatusCode },
  });
}

function fakeClient(
  handler: (command: GetObjectCommand | PutObjectCommand, callIndex: number) => Promise<unknown> | unknown,
): Pick<S3Client, "send"> & { calls: Array<GetObjectCommand | PutObjectCommand> } {
  const calls: Array<GetObjectCommand | PutObjectCommand> = [];
  return {
    calls,
    async send(command) {
      assert.ok(command instanceof GetObjectCommand || command instanceof PutObjectCommand);
      calls.push(command);
      return await handler(command, calls.length - 1);
    },
  };
}

class ThrowingCacheStore implements MemoryObjectStore {
  constructor(private fallbackContent: string | null = null) {}

  async readText() {
    return { content: this.fallbackContent };
  }

  async writeText() {
    throw new Error("cache write failed");
  }
}

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("S3MemoryObjectStore", () => {
  it("reads MEMORY.md from the normalized S3 key and returns content plus ETag", async () => {
    const client = fakeClient((command) => {
      assert.ok(command instanceof GetObjectCommand);
      assert.deepStrictEqual(command.input, {
        Bucket: "memory-bucket",
        Key: "base/global/MEMORY.md",
      });
      return {
        Body: bodyOf("remote memory"),
        ETag: '"etag-1"',
      };
    });

    const store = new S3MemoryObjectStore({
      endpoint: "https://s3.example.com",
      accessKey: "access-key",
      secretKey: "secret-key",
      bucket: "memory-bucket",
      path: "/base/global/",
    }, client);

    const result = await store.readText("MEMORY.md");
    assert.deepStrictEqual(result, { content: "remote memory", version: '"etag-1"' });
    assert.equal(client.calls.length, 1);
  });

  it("uses the configured adapter path for sidecar markdown keys", async () => {
    const expectations = [
      { adapterPath: "prefix/global", expectedKey: "prefix/global/y_memory.md" },
      { adapterPath: "prefix/projects/a%20b", expectedKey: "prefix/projects/a%20b/y_memory.md" },
    ];

    for (const { adapterPath, expectedKey } of expectations) {
      const client = fakeClient((command) => {
        assert.ok(command instanceof GetObjectCommand);
        assert.equal(command.input.Key, expectedKey);
        return { Body: bodyOf("details"), ETag: '"etag-sidecar"' };
      });
      const store = new S3MemoryObjectStore({
        endpoint: "https://s3.example.com",
        accessKey: "access-key",
        secretKey: "secret-key",
        bucket: "memory-bucket",
        path: adapterPath,
      }, client);

      const result = await store.readText("y_memory.md");
      assert.equal(result.content, "details");
      assert.equal(result.version, '"etag-sidecar"');
    }
  });

  it("returns null for missing objects signaled as NoSuchKey, NotFound, or HTTP 404", async () => {
    for (const error of [
      s3Error("NoSuchKey", 404),
      s3Error("NotFound", 404),
      s3Error("AnythingElse", 404),
    ]) {
      const client = fakeClient(() => {
        throw error;
      });
      const store = new S3MemoryObjectStore({
        endpoint: "https://s3.example.com",
        accessKey: "access-key",
        secretKey: "secret-key",
        bucket: "memory-bucket",
        path: "base/global",
      }, client);

      const result = await store.readText("MEMORY.md");
      assert.deepStrictEqual(result, { content: null });
      assert.equal(client.calls.length, 1);
    }
  });

  it("uploads cached content when the remote object is missing and returns the uploaded version", async () => {
    const cacheWrites: Array<{ key: string; content: string }> = [];
    const cache: MemoryObjectStore = {
      async readText(key) {
        assert.equal(key, "MEMORY.md");
        return { content: "cached memory" };
      },
      async writeText(key, content) {
        cacheWrites.push({ key, content });
        return undefined;
      },
    };
    const client = fakeClient((command, callIndex) => {
      if (callIndex === 0) {
        assert.ok(command instanceof GetObjectCommand);
        throw s3Error("NoSuchKey", 404);
      }
      assert.ok(command instanceof PutObjectCommand);
      assert.deepStrictEqual(command.input, {
        Bucket: "memory-bucket",
        Key: "base/global/MEMORY.md",
        Body: "cached memory",
        ContentType: "text/markdown; charset=utf-8",
        IfNoneMatch: "*",
      });
      return { ETag: '"etag-uploaded"' };
    });

    const store = new S3MemoryObjectStore({
      endpoint: "https://s3.example.com",
      accessKey: "access-key",
      secretKey: "secret-key",
      bucket: "memory-bucket",
      path: "base/global",
      localCache: cache,
    }, client);

    const result = await store.readText("MEMORY.md");
    assert.deepStrictEqual(result, { content: "cached memory", version: '"etag-uploaded"' });
    assert.deepStrictEqual(cacheWrites, [{ key: "MEMORY.md", content: "cached memory" }]);
  });

  it("re-reads the remote object once when cached upload loses a create race", async () => {
    const cacheWrites: Array<{ key: string; content: string }> = [];
    const cache: MemoryObjectStore = {
      async readText() {
        return { content: "cached memory" };
      },
      async writeText(key, content) {
        cacheWrites.push({ key, content });
        return undefined;
      },
    };
    const client = fakeClient((command, callIndex) => {
      if (callIndex === 0) {
        assert.ok(command instanceof GetObjectCommand);
        throw s3Error("NoSuchKey", 404);
      }
      if (callIndex === 1) {
        assert.ok(command instanceof PutObjectCommand);
        assert.equal(command.input.IfNoneMatch, "*");
        throw s3Error("PreconditionFailed", 412);
      }
      assert.ok(command instanceof GetObjectCommand);
      return {
        Body: bodyOf("remote memory"),
        ETag: '"etag-remote"',
      };
    });

    const store = new S3MemoryObjectStore({
      endpoint: "https://s3.example.com",
      accessKey: "access-key",
      secretKey: "secret-key",
      bucket: "memory-bucket",
      path: "base/global",
      localCache: cache,
    }, client);

    const result = await store.readText("MEMORY.md");
    assert.deepStrictEqual(result, { content: "remote memory", version: '"etag-remote"' });
    assert.deepStrictEqual(cacheWrites, [{ key: "MEMORY.md", content: "remote memory" }]);
    assert.deepStrictEqual(client.calls.map((command) => command.constructor.name), [
      "GetObjectCommand",
      "PutObjectCommand",
      "GetObjectCommand",
    ]);
  });

  it("writes with IfMatch, Markdown content type, and returns the new ETag", async () => {
    const client = fakeClient((command) => {
      assert.ok(command instanceof PutObjectCommand);
      assert.deepStrictEqual(command.input, {
        Bucket: "memory-bucket",
        Key: "base/global/MEMORY.md",
        Body: "entry",
        ContentType: "text/markdown; charset=utf-8",
        IfMatch: '"etag-1"',
      });
      return { ETag: '"etag-2"' };
    });
    const store = new S3MemoryObjectStore({
      endpoint: "https://s3.example.com",
      accessKey: "access-key",
      secretKey: "secret-key",
      bucket: "memory-bucket",
      path: "base/global",
    }, client);

    const version = await store.writeText("MEMORY.md", "entry", '"etag-1"');
    assert.equal(version, '"etag-2"');
  });

  it("creates writes with IfNoneMatch when no expected version is provided", async () => {
    const client = fakeClient((command) => {
      assert.ok(command instanceof PutObjectCommand);
      assert.equal(command.input.IfNoneMatch, "*");
      assert.equal(command.input.IfMatch, undefined);
      return { ETag: '"etag-created"' };
    });
    const store = new S3MemoryObjectStore({
      endpoint: "https://s3.example.com",
      accessKey: "access-key",
      secretKey: "secret-key",
      bucket: "memory-bucket",
      path: "base/global",
    }, client);

    const version = await store.writeText("MEMORY.md", "entry");
    assert.equal(version, '"etag-created"');
  });

  it("maps 409 and 412 write failures to StorageConflictError", async () => {
    for (const httpStatusCode of [409, 412]) {
      const client = fakeClient(() => {
        throw s3Error("Conflict", httpStatusCode);
      });
      const store = new S3MemoryObjectStore({
        endpoint: "https://s3.example.com",
        accessKey: "access-key",
        secretKey: "secret-key",
        bucket: "memory-bucket",
        path: "base/global",
      }, client);

      await assert.rejects(() => store.writeText("MEMORY.md", "entry"), StorageConflictError);
    }
  });

  it("rejects unsafe keys before sending any S3 requests", async () => {
    const client = fakeClient(() => ({ ETag: '"unused"' }));
    const store = new S3MemoryObjectStore({
      endpoint: "https://s3.example.com",
      accessKey: "access-key",
      secretKey: "secret-key",
      bucket: "memory-bucket",
      path: "base/global",
    }, client);

    for (const key of ["../secret.md", "/tmp/y_memory.md", ".hidden.md", "nested/y_memory.md", "notes.txt"]) {
      await assert.rejects(() => store.readText(key), /Unsafe memory object key/);
      await assert.rejects(() => store.writeText(key, "entry"), /Unsafe memory object key/);
    }

    assert.equal(client.calls.length, 0);
  });

  it("mirrors successful reads and writes into the local cache", async () => {
    const cacheDir = await makeTempDir("s3-memory-cache-");
    const client = fakeClient((command, callIndex) => {
      if (callIndex === 0) {
        assert.ok(command instanceof GetObjectCommand);
        return { Body: bodyOf("remote memory"), ETag: '"etag-read"' };
      }
      assert.ok(command instanceof PutObjectCommand);
      return { ETag: '"etag-write"' };
    });
    const store = new S3MemoryObjectStore({
      endpoint: "https://s3.example.com",
      accessKey: "access-key",
      secretKey: "secret-key",
      bucket: "memory-bucket",
      path: "base/global",
      localCache: new LocalMemoryObjectStore(cacheDir),
    }, client);

    await store.readText("MEMORY.md");
    assert.equal(await fs.readFile(path.join(cacheDir, "MEMORY.md"), "utf-8"), "remote memory");

    await store.writeText("y_memory.md", "detail text");
    assert.equal(await fs.readFile(path.join(cacheDir, "y_memory.md"), "utf-8"), "detail text");
  });

  it("does not let cache write failures mask successful remote reads or writes", async () => {
    const client = fakeClient((command, callIndex) => {
      if (callIndex === 0) {
        assert.ok(command instanceof GetObjectCommand);
        return { Body: bodyOf("remote memory"), ETag: '"etag-read"' };
      }
      assert.ok(command instanceof PutObjectCommand);
      return { ETag: '"etag-write"' };
    });
    const store = new S3MemoryObjectStore({
      endpoint: "https://s3.example.com",
      accessKey: "access-key",
      secretKey: "secret-key",
      bucket: "memory-bucket",
      path: "base/global",
      localCache: new ThrowingCacheStore(),
    }, client);

    const readResult = await store.readText("MEMORY.md");
    assert.deepStrictEqual(readResult, { content: "remote memory", version: '"etag-read"' });

    const writeVersion = await store.writeText("MEMORY.md", "entry");
    assert.equal(writeVersion, '"etag-write"');
  });
});
