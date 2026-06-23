import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMemoryObjectStore, joinS3Path } from "../../src/store/memory-store-factory.js";
import { LocalMemoryObjectStore } from "../../src/store/memory-object-store.js";
import { S3MemoryObjectStore } from "../../src/store/s3-memory-object-store.js";
import type { MemoryConfig } from "../../src/types.js";

function makeConfig(overrides?: Partial<MemoryConfig>): MemoryConfig {
  return {
    memoryMode: "policy-only",
    memoryCharLimit: 5000,
    userCharLimit: 5000,
    projectCharLimit: 5000,
    nudgeInterval: 10,
    reviewEnabled: true,
    flushOnCompact: true,
    flushOnShutdown: true,
    flushMinTurns: 6,
    autoConsolidate: true,
    correctionDetection: true,
    failureInjectionEnabled: true,
    failureInjectionMaxAgeDays: 7,
    failureInjectionMaxEntries: 5,
    nudgeToolCalls: 15,
    consolidationTimeoutMs: 60000,
    projectsMemoryDir: "projects-memory",
    sessionSearch: { variant: "legacy" },
    storage: { backend: "local" },
    ...overrides,
  };
}

describe("memory-store-factory", () => {
  it("normalizes and joins S3 path segments", () => {
    assert.equal(joinS3Path("/base/", "global"), "base/global");
    assert.equal(joinS3Path("", "projects", "a%20b"), "projects/a%20b");
    assert.equal(joinS3Path("//base//", "/nested/", "leaf/"), "base/nested/leaf");
  });

  it("creates LocalMemoryObjectStore for local backend", () => {
    const store = createMemoryObjectStore(makeConfig(), "/tmp/local-memory", "global");
    assert.ok(store instanceof LocalMemoryObjectStore);
  });

  it("creates S3MemoryObjectStore for s3 backend", () => {
    const store = createMemoryObjectStore(makeConfig({
      storage: {
        backend: "s3",
        s3: {
          endpoint: "https://s3.example.com",
          accessKey: "access",
          secretKey: "secret",
          bucket: "bucket",
          path: "root",
          forcePathStyle: true,
        },
      },
    }), "/tmp/local-memory", "projects/my-project");
    assert.ok(store instanceof S3MemoryObjectStore);
  });

  it("creates S3MemoryObjectStore for s3 backend with localCache disabled", () => {
    const store = createMemoryObjectStore(makeConfig({
      storage: {
        backend: "s3",
        s3: {
          endpoint: "https://s3.example.com",
          accessKey: "access",
          secretKey: "secret",
          bucket: "bucket",
          path: "root",
          forcePathStyle: true,
          localCache: false,
        },
      },
    }), "/tmp/local-memory", "projects/my-project");
    assert.ok(store instanceof S3MemoryObjectStore);
  });
});
