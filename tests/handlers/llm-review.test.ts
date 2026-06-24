/**
 * Unit tests for the in-process LLM review pipeline.
 *
 * Tests the JSON extraction, operation validation, and store application logic
 * without requiring a real LLM call (uses mock llmCall injection).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  extractJsonArray,
  applyMemoryOperations,
  resolveReviewModel,
  runLlmReview,
  reviewAndApply,
} from "../../src/handlers/llm-review.js";
import type { LlmCallFn } from "../../src/handlers/llm-review.js";
import { MemoryStore } from "../../src/store/memory-store.js";
import {
  REVIEW_SYSTEM_PROMPT,
  REVIEW_USER_PROMPT,
  FLUSH_USER_PROMPT,
} from "../../src/constants.js";

// ─── Mock helpers ───

function createMockLlmCall(operations: unknown[] = []): LlmCallFn {
  return async () => ({
    role: "assistant" as const,
    content: [{ type: "text" as const, text: JSON.stringify(operations) }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  });
}

function createMockLlmCallText(text: string): LlmCallFn {
  return async () => ({
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  });
}

function createMockCtx(modelOverride?: object) {
  return {
    model: modelOverride ?? { id: "test-model", provider: "anthropic", api: "anthropic-messages" },
    modelRegistry: {
      getApiKey: async () => "test-key",
      getAll: () => [],
    },
  };
}

async function createTempStore(): Promise<{ store: MemoryStore; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-review-test-"));
  const store = new MemoryStore({ memoryDir: dir, memoryCharLimit: 5000, userCharLimit: 5000 });
  await store.loadFromDisk();
  return { store, dir };
}

// ─── extractJsonArray ───

describe("extractJsonArray", () => {
  it("parses a plain JSON array", () => {
    const ops = extractJsonArray('[{"action":"add","target":"user","content":"test"}]');
    assert.strictEqual(ops.length, 1);
    assert.strictEqual(ops[0].action, "add");
    assert.strictEqual(ops[0].target, "user");
  });

  it("parses JSON wrapped in markdown fences", () => {
    const ops = extractJsonArray('```json\n[{"action":"add","target":"memory","content":"fact"}]\n```');
    assert.strictEqual(ops.length, 1);
    assert.strictEqual(ops[0].content, "fact");
  });

  it("parses JSON after prose text", () => {
    const ops = extractJsonArray('Here are my findings:\n[{"action":"add","target":"user","content":"name is Bob"}]');
    assert.strictEqual(ops.length, 1);
  });

  it("returns empty array for empty input", () => {
    assert.deepStrictEqual(extractJsonArray(""), []);
  });

  it("returns empty array for text without JSON", () => {
    assert.deepStrictEqual(extractJsonArray("Nothing to save."), []);
  });

  it("returns empty array for invalid JSON", () => {
    assert.deepStrictEqual(extractJsonArray("[invalid json]"), []);
  });

  it("handles nested brackets in JSON strings", () => {
    const ops = extractJsonArray('[{"action":"add","target":"memory","content":"array like [1,2,3]"}]');
    assert.strictEqual(ops.length, 1);
    assert.strictEqual(ops[0].content, "array like [1,2,3]");
  });

  it("filters out invalid operations", () => {
    const ops = extractJsonArray('["just a string", {"action":"add","target":"user","content":"valid"}, {"foo":"bar"}]');
    assert.strictEqual(ops.length, 1);
    assert.strictEqual(ops[0].content, "valid");
  });

  it("parses multiple operations", () => {
    const ops = extractJsonArray([
      '[{"action":"add","target":"user","content":"prefers dark mode"}',
      ',{"action":"add","target":"failure","content":"test failed","category":"failure"}]',
    ].join(""));
    assert.strictEqual(ops.length, 2);
  });
});

// ─── resolveReviewModel ───

describe("resolveReviewModel", () => {
  it("returns ctx.model when no override", () => {
    const model = { id: "claude-3", provider: "anthropic", api: "anthropic-messages" };
    const result = resolveReviewModel(createMockCtx(model), {});
    assert.strictEqual(result, model);
  });

  it("returns null when no model available", () => {
    const ctx = { model: undefined, modelRegistry: { getApiKey: async () => "key", getAll: () => [] } };
    const result = resolveReviewModel(ctx, {});
    assert.strictEqual(result, null);
  });

  it("resolves model override by provider/id", () => {
    const models = [
      { id: "claude-3", provider: "anthropic", api: "anthropic-messages" },
      { id: "gpt-4", provider: "openai", api: "openai-responses" },
    ];
    const ctx = {
      model: models[0],
      modelRegistry: { getApiKey: async () => "key", getAll: () => models },
    };
    const result = resolveReviewModel(ctx, { llmModelOverride: "openai/gpt-4" });
    assert.ok(result);
    assert.strictEqual(result.id, "gpt-4");
  });

  it("resolves model override by id only", () => {
    const models = [
      { id: "claude-3", provider: "anthropic", api: "anthropic-messages" },
    ];
    const ctx = {
      model: undefined,
      modelRegistry: { getApiKey: async () => "key", getAll: () => models },
    };
    const result = resolveReviewModel(ctx, { llmModelOverride: "claude-3" });
    assert.ok(result);
    assert.strictEqual(result.id, "claude-3");
  });

  it("falls back to ctx.model when override not found", () => {
    const model = { id: "claude-3", provider: "anthropic", api: "anthropic-messages" };
    const ctx = {
      model,
      modelRegistry: { getApiKey: async () => "key", getAll: () => [model] },
    };
    const result = resolveReviewModel(ctx, { llmModelOverride: "nonexistent-model" });
    assert.strictEqual(result, model);
  });
});

// ─── applyMemoryOperations ───

describe("applyMemoryOperations", () => {
  it("applies add operations to the store", async () => {
    const { store, dir } = await createTempStore();
    try {
      const ops = [
        { action: "add" as const, target: "user" as const, content: "User prefers pnpm" },
        { action: "add" as const, target: "memory" as const, content: "Node 22 is installed" },
      ];
      const result = await applyMemoryOperations(store, null, ops);
      assert.strictEqual(result.applied, 2);
      assert.strictEqual(result.skipped, 0);
      assert.strictEqual(store.getUserEntries().length, 1);
      assert.strictEqual(store.getMemoryEntries().length, 1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("applies add for failure target with category", async () => {
    const { store, dir } = await createTempStore();
    try {
      const ops = [
        { action: "add" as const, target: "failure" as const, content: "localStorage for tokens is XSS vulnerable", category: "failure" as const, failure_reason: "security risk" },
      ];
      const result = await applyMemoryOperations(store, null, ops);
      assert.strictEqual(result.applied, 1);
      assert.ok(store.getAllFailureEntries().length > 0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("skips add without content", async () => {
    const { store, dir } = await createTempStore();
    try {
      const ops = [{ action: "add" as const, target: "user" as const }];
      const result = await applyMemoryOperations(store, null, ops);
      assert.strictEqual(result.applied, 0);
      assert.strictEqual(result.skipped, 1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("applies replace operations", async () => {
    const { store, dir } = await createTempStore();
    try {
      await store.add("user", "User prefers npm");
      const ops = [
        { action: "replace" as const, target: "user" as const, match: "prefers npm", content: "User prefers pnpm" },
      ];
      const result = await applyMemoryOperations(store, null, ops);
      assert.strictEqual(result.applied, 1);
      const entries = store.getUserEntries();
      assert.ok(entries.some((e) => e.includes("pnpm")));
      assert.ok(!entries.some((e) => e.includes("prefers npm") && !e.includes("pnpm")));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("applies remove operations", async () => {
    const { store, dir } = await createTempStore();
    try {
      await store.add("memory", "Some stale fact");
      const ops = [
        { action: "remove" as const, target: "memory" as const, match: "stale fact" },
      ];
      const result = await applyMemoryOperations(store, null, ops);
      assert.strictEqual(result.applied, 1);
      assert.strictEqual(store.getMemoryEntries().length, 0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("routes project target to projectStore", async () => {
    const { store: globalStore, dir: globalDir } = await createTempStore();
    const { store: projectStore, dir: projectDir } = await createTempStore();
    try {
      const ops = [
        { action: "add" as const, target: "project" as const, content: "Uses turborepo" },
      ];
      const result = await applyMemoryOperations(globalStore, projectStore, ops);
      assert.strictEqual(result.applied, 1);
      assert.strictEqual(globalStore.getMemoryEntries().length, 0);
      assert.strictEqual(projectStore.getMemoryEntries().length, 1);
    } finally {
      await fs.rm(globalDir, { recursive: true, force: true });
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });

  it("skips project operations when no projectStore", async () => {
    const { store, dir } = await createTempStore();
    try {
      const ops = [{ action: "add" as const, target: "project" as const, content: "test" }];
      const result = await applyMemoryOperations(store, null, ops);
      assert.strictEqual(result.applied, 0);
      assert.strictEqual(result.skipped, 1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// ─── runLlmReview ───

describe("runLlmReview", () => {
  it("returns text from the LLM call", async () => {
    const mockLlmCall = createMockLlmCall([{ action: "add", target: "user", content: "test" }]);
    const result = await runLlmReview(
      createMockCtx(),
      "system prompt",
      "user prompt",
      {},
      { llmCall: mockLlmCall },
    );
    assert.ok(result.text.includes('"action"'));
    assert.ok(!result.error);
  });

  it("returns error when no model available", async () => {
    const result = await runLlmReview(
      createMockCtx(undefined),
      "system prompt",
      "user prompt",
      {},
    );
    assert.ok(result.error);
    assert.strictEqual(result.text, "");
  });

  it("handles LLM call errors", async () => {
    const failingLlmCall: LlmCallFn = async () => { throw new Error("API error"); };
    const result = await runLlmReview(
      createMockCtx(),
      "system prompt",
      "user prompt",
      {},
      { llmCall: failingLlmCall },
    );
    assert.ok(result.error);
    assert.strictEqual(result.error, "API error");
  });

  it("extracts text from multi-block content", async () => {
    const multiBlockLlmCall: LlmCallFn = async () => ({
      role: "assistant" as const,
      content: [
        { type: "text" as const, text: "first " },
        { type: "text" as const, text: "second" },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop" as const,
      timestamp: Date.now(),
    });
    const result = await runLlmReview(
      createMockCtx(),
      "system prompt",
      "user prompt",
      {},
      { llmCall: multiBlockLlmCall },
    );
    assert.strictEqual(result.text, "first second");
  });
});

describe("review prompt scope guidance", () => {
  it("keeps scope rules in the review system prompt", () => {
    assert.match(REVIEW_SYSTEM_PROMPT, /SCOPE RULES/);
    assert.match(REVIEW_SYSTEM_PROMPT, /If content names a repository/);
    assert.match(REVIEW_SYSTEM_PROMPT, /Do not emit target="failure" for the raw incident/);
    assert.match(REVIEW_SYSTEM_PROMPT, /\{"action":"add","target":"project","content":"When reconciling Hermes local changes with upstream/);
  });

  it("keeps project-first scope guidance in the review user prompt", () => {
    assert.match(REVIEW_USER_PROMPT, /Repo-specific commands, paths, APIs, architecture, workflows, bugs, migrations, branches, versions, and conventions \(target: "project"\)/);
    assert.match(REVIEW_USER_PROMPT, /choose target="project" instead of user\/memory\/failure/);
  });

  it("keeps project-first scope guidance in the flush prompt", () => {
    assert.match(FLUSH_USER_PROMPT, /Project-specific corrections, workflows, bugs, commands, paths, APIs, migrations, branches, and versions go to target="project"/);
    assert.match(FLUSH_USER_PROMPT, /USER\.md is only for person-level facts/);
  });
});

// ─── reviewAndApply ───

describe("reviewAndApply", () => {
  it("applies operations from LLM output", async () => {
    const { store, dir } = await createTempStore();
    try {
      const mockLlmCall = createMockLlmCall([
        { action: "add", target: "user", content: "Name is Alice" },
      ]);
      const result = await reviewAndApply(
        createMockCtx(),
        "system",
        "user",
        store,
        null,
        {},
        { llmCall: mockLlmCall },
      );
      assert.strictEqual(result.applied, 1);
      assert.strictEqual(result.nothingToSave, false);
      assert.strictEqual(store.getUserEntries().length, 1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns nothingToSave when LLM says nothing to save", async () => {
    const { store, dir } = await createTempStore();
    try {
      const result = await reviewAndApply(
        createMockCtx(),
        "system",
        "user",
        store,
        null,
        {},
        { llmCall: createMockLlmCallText("Nothing to save.") },
      );
      assert.strictEqual(result.applied, 0);
      assert.strictEqual(result.nothingToSave, true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns nothingToSave when JSON array is empty", async () => {
    const { store, dir } = await createTempStore();
    try {
      const result = await reviewAndApply(
        createMockCtx(),
        "system",
        "user",
        store,
        null,
        {},
        { llmCall: createMockLlmCall([]) },
      );
      assert.strictEqual(result.applied, 0);
      assert.strictEqual(result.nothingToSave, true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns error when model is unavailable", async () => {
    const { store, dir } = await createTempStore();
    try {
      const result = await reviewAndApply(
        createMockCtx(undefined),
        "system",
        "user",
        store,
        null,
        {},
      );
      assert.ok(result.error);
      assert.strictEqual(result.applied, 0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
