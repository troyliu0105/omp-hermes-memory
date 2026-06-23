import { afterEach, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { MemoryStore } from "../../src/store/memory-store.js";
import {
  MEMORY_LIST_TOOL_NAME,
  registerMemoryListTool,
} from "../../src/tools/memory-list-tool.js";
import type { MemoryConfig } from "../../src/types.js";

let ROOT_DIR = "";

interface RegisteredTool {
  name: string;
  label: string;
  parameters: unknown;
  execute: (toolCallId: string, params: { target?: "all" | "memory" | "user" | "project" | "failure" }) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: unknown;
  }>;
}

interface ParsedSuccessResult {
  success: true;
  target: "all" | "memory" | "user" | "project" | "failure";
  total_count: number;
  project_available: boolean;
  project_name?: string;
  targets: Array<{
    target: "memory" | "user" | "project" | "failure";
    entry_count: number;
    entries: string[];
  }>;
  message?: string;
}

interface ParsedErrorResult {
  success: false;
  target: "all" | "memory" | "user" | "project" | "failure";
  total_count: number;
  project_available: boolean;
  targets: Array<{
    target: "memory" | "user" | "project" | "failure";
    entry_count: number;
    entries: string[];
  }>;
  error: string;
}

function makeConfig(memoryDir: string): MemoryConfig {
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
    memoryDir,
  };
}

function makeMockPi(setCaptured: (tool: RegisteredTool) => void): ExtensionAPI {
  return {
    registerTool(def: RegisteredTool) {
      setCaptured(def);
    },
  } as unknown as ExtensionAPI;
}

function parseToolText(text: string): ParsedSuccessResult | ParsedErrorResult {
  return JSON.parse(text) as ParsedSuccessResult | ParsedErrorResult;
}

afterEach(() => {
  if (ROOT_DIR) fs.rmSync(ROOT_DIR, { recursive: true, force: true });
  ROOT_DIR = "";
});

describe("registerMemoryListTool", () => {
  it("registers tool with name 'memory_list' and correct parameters", () => {
    let captured: RegisteredTool | undefined;
    const mockPi = makeMockPi((tool) => {
      captured = tool;
    });

    const mockStore = {
      getMemoryEntries: () => [],
      getUserEntries: () => [],
      getAllFailureEntries: () => [],
    } as unknown as MemoryStore;

    registerMemoryListTool(mockPi, mockStore, null);

    assert.ok(captured, "tool should be registered");
    assert.strictEqual(captured.name, MEMORY_LIST_TOOL_NAME);
    assert.strictEqual(captured.label, "Memory List");
    assert.ok(captured.parameters, "parameters schema should be defined");
  });

  it("lists all targets in fixed order and mirrors details", async () => {
    let captured: RegisteredTool | undefined;
    const mockPi = makeMockPi((tool) => {
      captured = tool;
    });

    const mockStore = {
      getMemoryEntries: () => ["global one"],
      getUserEntries: () => ["user one"],
      getAllFailureEntries: () => ["[failure] failure one"],
    } as unknown as MemoryStore;
    const projectStore = {
      getMemoryEntries: () => ["project one"],
    } as unknown as MemoryStore;

    registerMemoryListTool(mockPi, mockStore, projectStore, "project-a");
    assert.ok(captured, "tool should be registered");

    const result = await captured.execute("tc-1", {});
    const parsed = parseToolText(result.content[0].text);

    assert.strictEqual(parsed.success, true);
    if (!parsed.success) {
      assert.fail("expected success result");
    }
    assert.strictEqual(parsed.target, "all");
    assert.strictEqual(parsed.total_count, 4);
    assert.strictEqual(parsed.project_available, true);
    assert.strictEqual(parsed.project_name, "project-a");
    assert.deepStrictEqual(
      parsed.targets.map((block) => block.target),
      ["memory", "user", "project", "failure"],
    );
    assert.deepStrictEqual(parsed, result.details);
  });

  it("filters to a single requested target", async () => {
    let captured: RegisteredTool | undefined;
    const mockPi = makeMockPi((tool) => {
      captured = tool;
    });

    const mockStore = {
      getMemoryEntries: () => ["global one"],
      getUserEntries: () => ["user one"],
      getAllFailureEntries: () => ["[failure] failure one"],
    } as unknown as MemoryStore;
    const projectStore = {
      getMemoryEntries: () => ["project one"],
    } as unknown as MemoryStore;

    registerMemoryListTool(mockPi, mockStore, projectStore, "project-a");
    assert.ok(captured, "tool should be registered");

    const result = await captured.execute("tc-1", { target: "user" });
    const parsed = parseToolText(result.content[0].text);

    assert.strictEqual(parsed.success, true);
    if (!parsed.success) {
      assert.fail("expected success result");
    }
    assert.strictEqual(parsed.target, "user");
    assert.strictEqual(parsed.total_count, 1);
    assert.deepStrictEqual(parsed.targets, [
      { target: "user", entry_count: 1, entries: ["user one"] },
    ]);
  });

  it("returns a success result with message for empty state", async () => {
    let captured: RegisteredTool | undefined;
    const mockPi = makeMockPi((tool) => {
      captured = tool;
    });

    const mockStore = {
      getMemoryEntries: () => [],
      getUserEntries: () => [],
      getAllFailureEntries: () => [],
    } as unknown as MemoryStore;
    const projectStore = {
      getMemoryEntries: () => [],
    } as unknown as MemoryStore;

    registerMemoryListTool(mockPi, mockStore, projectStore, "project-a");
    assert.ok(captured, "tool should be registered");

    const result = await captured.execute("tc-1", { target: "all" });
    const parsed = parseToolText(result.content[0].text);

    assert.strictEqual(parsed.success, true);
    if (!parsed.success) {
      assert.fail("expected success result");
    }
    assert.strictEqual(parsed.total_count, 0);
    assert.strictEqual(parsed.message, "No current memory entries found.");
  });

  it("returns a structured error when project memory is unavailable", async () => {
    let captured: RegisteredTool | undefined;
    const mockPi = makeMockPi((tool) => {
      captured = tool;
    });

    const mockStore = {
      getMemoryEntries: () => [],
      getUserEntries: () => [],
      getAllFailureEntries: () => [],
    } as unknown as MemoryStore;

    registerMemoryListTool(mockPi, mockStore, null);
    assert.ok(captured, "tool should be registered");

    const result = await captured.execute("tc-1", { target: "project" });
    const parsed = parseToolText(result.content[0].text);

    assert.strictEqual(parsed.success, false);
    if (parsed.success) {
      assert.fail("expected error result");
    }
    assert.strictEqual(parsed.error, "Project memory is not available (no project detected).");
    assert.strictEqual(parsed.project_available, false);
    assert.deepStrictEqual(parsed.targets, []);
  });

  it("reads the current live stores without reloading from disk", async () => {
    ROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "memory-list-tool-test-"));
    const globalDir = path.join(ROOT_DIR, "global");
    const projectDir = path.join(ROOT_DIR, "project");

    const store = new MemoryStore(makeConfig(globalDir));
    const projectStore = new MemoryStore(makeConfig(projectDir));
    await store.loadFromDisk();
    await projectStore.loadFromDisk();

    const globalAdd = await store.add("memory", "global live entry");
    assert.strictEqual(globalAdd.success, true);
    const userAdd = await store.add("user", "user live entry");
    assert.strictEqual(userAdd.success, true);
    const failureAdd = await store.addFailure("failure live entry", {
      category: "failure",
      failureReason: "live test",
    });
    assert.strictEqual(failureAdd.success, true);
    const projectAdd = await projectStore.add("memory", "project live entry");
    assert.strictEqual(projectAdd.success, true);

    let captured: RegisteredTool | undefined;
    const mockPi = makeMockPi((tool) => {
      captured = tool;
    });

    registerMemoryListTool(mockPi, store, projectStore, "project-a");
    assert.ok(captured, "tool should be registered");

    const result = await captured.execute("tc-1", {});
    const parsed = parseToolText(result.content[0].text);

    assert.strictEqual(parsed.success, true);
    if (!parsed.success) {
      assert.fail("expected success result");
    }

    const byTarget = new Map(parsed.targets.map((block) => [block.target, block.entries]));
    assert.deepStrictEqual(byTarget.get("memory"), ["global live entry"]);
    assert.deepStrictEqual(byTarget.get("user"), ["user live entry"]);
    assert.deepStrictEqual(byTarget.get("project"), ["project live entry"]);
    assert.strictEqual(byTarget.get("failure")?.length, 1);
    const failureEntries = byTarget.get("failure");
    assert.ok(failureEntries, "failure entries should exist");
    assert.match(failureEntries[0], /failure live entry/);
    assert.match(failureEntries[0], /\[failure\]/);
  });
});
