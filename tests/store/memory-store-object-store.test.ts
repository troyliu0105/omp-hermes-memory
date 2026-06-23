import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ENTRY_DELIMITER } from "../../src/constants.js";
import { MemoryStore } from "../../src/store/memory-store.js";
import { StorageConflictError, type MemoryObjectReadResult, type MemoryObjectStore } from "../../src/store/memory-object-store.js";
import type { MemoryConfig } from "../../src/types.js";

function makeConfig(overrides?: Partial<MemoryConfig>): MemoryConfig {
  return {
    memoryMode: "legacy-inject",
    memoryCharLimit: 5000,
    userCharLimit: 5000,
    projectCharLimit: 5000,
    nudgeInterval: 10,
    reviewEnabled: false,
    flushOnCompact: false,
    flushOnShutdown: false,
    flushMinTurns: 6,
    autoConsolidate: false,
    correctionDetection: false,
    failureInjectionEnabled: true,
    failureInjectionMaxAgeDays: 7,
    failureInjectionMaxEntries: 5,
    nudgeToolCalls: 15,
    memoryDir: "/virtual-memory",
    storage: { backend: "local" },
    ...overrides,
  };
}

class InMemoryObjectStore implements MemoryObjectStore {
  public ensureReadyCalls = 0;
  public readCalls: string[] = [];
  public writeCalls: Array<{ key: string; content: string; expectedVersion?: string }> = [];
  protected objects = new Map<string, { content: string; version?: string }>();
  private versionCounter = 0;

  constructor(initial?: Record<string, string>) {
    for (const [key, content] of Object.entries(initial ?? {})) {
      this.objects.set(key, { content, version: `v${++this.versionCounter}` });
    }
  }

  async ensureReady(): Promise<void> {
    this.ensureReadyCalls += 1;
  }

  async readText(key: string): Promise<MemoryObjectReadResult> {
    this.readCalls.push(key);
    const object = this.objects.get(key);
    return object ? { content: object.content, version: object.version } : { content: null };
  }

  async writeText(key: string, content: string, expectedVersion?: string): Promise<string | undefined> {
    this.writeCalls.push({ key, content, expectedVersion });
    const current = this.objects.get(key);
    if (expectedVersion !== undefined && current?.version !== expectedVersion) {
      throw new StorageConflictError(`Expected ${expectedVersion}, got ${current?.version ?? "missing"}`);
    }
    if (expectedVersion === undefined && current) {
      throw new StorageConflictError(`Expected create, found ${current.version}`);
    }
    const version = `v${++this.versionCounter}`;
    this.objects.set(key, { content, version });
    return version;
  }

  seed(key: string, content: string): void {
    const version = `v${++this.versionCounter}`;
    this.objects.set(key, { content, version });
  }

  get(key: string): string | undefined {
    return this.objects.get(key)?.content;
  }
}

class ConflictOnceObjectStore extends InMemoryObjectStore {
  private firstMemoryWrite = true;

  override async writeText(key: string, content: string, expectedVersion?: string): Promise<string | undefined> {
    if (key === "MEMORY.md" && this.firstMemoryWrite) {
      this.firstMemoryWrite = false;
      this.seed("MEMORY.md", "peer entry <!-- created=2026-06-23, last=2026-06-23 -->");
      throw new StorageConflictError("simulated conflict");
    }
    return super.writeText(key, content, expectedVersion);
  }
}

class AlwaysConflictObjectStore extends InMemoryObjectStore {
  override async writeText(_key: string, _content: string, _expectedVersion?: string): Promise<string | undefined> {
    throw new StorageConflictError("always conflicting");
  }
}

describe("MemoryStore object-store integration", () => {
  it("loadFromDisk reads primary keys, preserves frozen snapshot behavior, and syncs referenced sidecars", async () => {
    const storeBackend = new InMemoryObjectStore({
      "MEMORY.md": [
        "alpha <!-- created=2026-06-23, last=2026-06-23 -->",
        "xxx，详情在 y_memory.md 中 <!-- created=2026-06-23, last=2026-06-23 -->",
      ].join(ENTRY_DELIMITER),
      "USER.md": "prefers pnpm <!-- created=2026-06-23, last=2026-06-23 -->",
      "failures.md": "[failure] avoid temp dirs <!-- created=2026-06-23, last=2026-06-23 -->",
      "y_memory.md": "sidecar detail",
    });
    const store = new MemoryStore(makeConfig(), { objectStore: storeBackend });

    await store.loadFromDisk();

    assert.equal(storeBackend.ensureReadyCalls, 1);
    assert.deepEqual(store.getMemoryEntries(), ["alpha", "xxx，详情在 y_memory.md 中"]);
    assert.deepEqual(store.getUserEntries(), ["prefers pnpm"]);
    assert.deepEqual(store.getAllFailureEntries(), ["[failure] avoid temp dirs"]);
    assert.ok(store.formatForSystemPrompt().includes("alpha"));
    assert.ok(store.formatForSystemPrompt().includes("prefers pnpm"));
    assert.ok(storeBackend.readCalls.includes("MEMORY.md"));
    assert.ok(storeBackend.readCalls.includes("USER.md"));
    assert.ok(storeBackend.readCalls.includes("failures.md"));
    assert.ok(storeBackend.readCalls.includes("y_memory.md"));
  });

  it("add writes only MEMORY.md and leaves USER.md unchanged", async () => {
    const storeBackend = new InMemoryObjectStore({
      "USER.md": "existing user <!-- created=2026-06-23, last=2026-06-23 -->",
    });
    const store = new MemoryStore(makeConfig(), { objectStore: storeBackend });
    await store.loadFromDisk();

    const result = await store.add("memory", "new memory entry");

    assert.ok(result.success);
    assert.equal(storeBackend.get("USER.md"), "existing user <!-- created=2026-06-23, last=2026-06-23 -->");
    assert.ok(storeBackend.get("MEMORY.md")?.includes("new memory entry"));
    assert.deepEqual(storeBackend.writeCalls.map((call) => call.key), ["MEMORY.md"]);
  });

  it("successful memory write syncs referenced y_memory.md through the object store", async () => {
    const storeBackend = new InMemoryObjectStore({
      "y_memory.md": "detail content",
    });
    const store = new MemoryStore(makeConfig(), { objectStore: storeBackend });
    await store.loadFromDisk();

    const result = await store.add("memory", "xxx，详情在 y_memory.md 中");

    assert.ok(result.success);
    assert.ok(storeBackend.readCalls.includes("y_memory.md"));
  });

  it("missing referenced y_memory.md does not fail loadFromDisk", async () => {
    const storeBackend = new InMemoryObjectStore({
      "MEMORY.md": "xxx，详情在 y_memory.md 中 <!-- created=2026-06-23, last=2026-06-23 -->",
    });
    const store = new MemoryStore(makeConfig(), { objectStore: storeBackend });

    await assert.doesNotReject(store.loadFromDisk());
    assert.deepEqual(store.getMemoryEntries(), ["xxx，详情在 y_memory.md 中"]);
  });

  it("conflict on first add write reloads latest entries and retries once", async () => {
    const storeBackend = new ConflictOnceObjectStore();
    const store = new MemoryStore(makeConfig(), { objectStore: storeBackend });
    await store.loadFromDisk();

    const result = await store.add("memory", "local entry");
    const persisted = storeBackend.get("MEMORY.md") ?? "";

    assert.ok(result.success);
    assert.ok(persisted.includes("peer entry"));
    assert.ok(persisted.includes("local entry"));
    assert.ok(persisted.includes(ENTRY_DELIMITER));
  });

  it("second conflict returns the exact user-visible conflict error", async () => {
    const store = new MemoryStore(makeConfig(), { objectStore: new AlwaysConflictObjectStore() });
    await store.loadFromDisk();

    const result = await store.add("memory", "local entry");

    assert.deepEqual(result, {
      success: false,
      error: "Memory changed on another device while saving. Re-run the memory operation to apply it to the latest S3 version.",
    });
  });

  it("non-conflict write failures still reject", async () => {
    const storeBackend: MemoryObjectStore = {
      async ensureReady(): Promise<void> {},
      async readText(): Promise<MemoryObjectReadResult> {
        return { content: null };
      },
      async writeText(): Promise<string | undefined> {
        throw new Error("disk full");
      },
    };
    const store = new MemoryStore(makeConfig(), { objectStore: storeBackend });
    await store.loadFromDisk();

    await assert.rejects(() => store.add("memory", "local entry"), /disk full/);
  });
});
