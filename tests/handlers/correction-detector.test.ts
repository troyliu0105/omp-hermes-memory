/**
 * Unit tests for correction detection — isCorrection() pattern matching
 * and handler behavior (rate limiting, triggering, failure memory save).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseManager } from "../../src/store/db.js";
import { getMemories } from "../../src/store/sqlite-memory-store.js";
import { isCorrection, setupCorrectionDetector } from "../../src/handlers/correction-detector.js";
import { MemoryUpdateGate } from "../../src/handlers/memory-update-gate.js";


let updateGate: MemoryUpdateGate;
// ─── Pattern matching tests ───

describe("isCorrection", () => {
  // ── Strong patterns (always trigger) ──

  describe("strong patterns (always trigger)", () => {
    it("matches 'don't do that'", () => {
      assert.strictEqual(isCorrection("don't do that"), true);
    });

    it("matches 'not like that'", () => {
      assert.strictEqual(isCorrection("not like that"), true);
    });

    it("matches 'I said use yarn'", () => {
      assert.strictEqual(isCorrection("I said use yarn"), true);
    });

    it("matches 'I told you already'", () => {
      assert.strictEqual(isCorrection("I told you already"), true);
    });

    it("matches 'we already discussed this'", () => {
      assert.strictEqual(isCorrection("we already discussed this"), true);
    });

    it("matches 'please don't commit yet'", () => {
      assert.strictEqual(isCorrection("please don't commit yet"), true);
    });

    it("matches \"that's not what I asked for\"", () => {
      assert.strictEqual(isCorrection("that's not what I asked for"), true);
    });
  });

  // ── Weak patterns (need directive clause) ──

  describe("weak patterns (need directive clause)", () => {
    it("matches 'no, use yarn instead' (has directive 'use')", () => {
      assert.strictEqual(isCorrection("no, use yarn instead"), true);
    });

    it("matches 'wrong, the file is in src/' (has directive 'the')", () => {
      assert.strictEqual(isCorrection("wrong, the file is in src/"), true);
    });

    it("matches 'actually, don't use that' (has directive 'don't')", () => {
      assert.strictEqual(isCorrection("actually, don't use that"), true);
    });

    it("matches 'stop, fix the test first' (has directive 'fix')", () => {
      assert.strictEqual(isCorrection("stop, fix the test first"), true);
    });

    it("matches 'no! delete that file' (has directive 'delete')", () => {
      assert.strictEqual(isCorrection("no! delete that file"), true);
    });

    it("does NOT match 'no just kidding' (no directive clause)", () => {
      assert.strictEqual(isCorrection("no just kidding"), false);
    });
  });

  // ── Negative patterns (suppress even if positive matches) ──

  describe("negative patterns (suppress false positives)", () => {
    it("suppresses 'no worries, I'll handle it'", () => {
      assert.strictEqual(isCorrection("no worries, I'll handle it"), false);
    });

    it("suppresses 'no problem'", () => {
      assert.strictEqual(isCorrection("no problem"), false);
    });

    it("suppresses 'no thanks'", () => {
      assert.strictEqual(isCorrection("no thanks"), false);
    });

    it("suppresses 'no need to change that'", () => {
      assert.strictEqual(isCorrection("no need to change that"), false);
    });

    it("suppresses 'actually, that looks great'", () => {
      assert.strictEqual(isCorrection("actually, that looks great"), false);
    });

    it("suppresses 'actually, perfect'", () => {
      assert.strictEqual(isCorrection("actually, perfect"), false);
    });

    it("suppresses 'actually, that's correct'", () => {
      assert.strictEqual(isCorrection("actually, that's correct"), false);
    });

    it("suppresses 'stop there'", () => {
      assert.strictEqual(isCorrection("stop there"), false);
    });

    it("suppresses 'stop here'", () => {
      assert.strictEqual(isCorrection("stop here"), false);
    });

    it("suppresses 'stop for now'", () => {
      assert.strictEqual(isCorrection("stop for now"), false);
    });
  });

  // ── Non-corrections (should NOT trigger) ──

  describe("non-corrections (should NOT trigger)", () => {
    it("does NOT match 'yes, do that'", () => {
      assert.strictEqual(isCorrection("yes, do that"), false);
    });

    it("does NOT match 'looks good'", () => {
      assert.strictEqual(isCorrection("looks good"), false);
    });

    it("does NOT match 'can you also check the tests?'", () => {
      assert.strictEqual(isCorrection("can you also check the tests?"), false);
    });

    it("does NOT match empty string", () => {
      assert.strictEqual(isCorrection(""), false);
    });

    it("does NOT match 'thanks'", () => {
      assert.strictEqual(isCorrection("thanks"), false);
    });

    it("does NOT match 'great, that works'", () => {
      assert.strictEqual(isCorrection("great, that works"), false);
    });

    it("does NOT match 'please continue'", () => {
      assert.strictEqual(isCorrection("please continue"), false);
    });
  });

  // ── Case insensitivity ──

  describe("case insensitivity", () => {
    it("matches 'DON'T DO THAT' (uppercase)", () => {
      assert.strictEqual(isCorrection("DON'T DO THAT"), true);
    });

    it("matches 'I Told You Already' (mixed case)", () => {
      assert.strictEqual(isCorrection("I Told You Already"), true);
    });

    it("suppresses 'No Worries' (uppercase negative)", () => {
      assert.strictEqual(isCorrection("No Worries"), false);
    });
  });

  describe("custom pattern config", () => {
    it("matches custom strong patterns", () => {
      assert.strictEqual(
        isCorrection("custom correction", { correctionStrongPatterns: ["^custom correction$"] }),
        true,
      );
    });

    it("uses custom negative patterns to suppress matches", () => {
      assert.strictEqual(
        isCorrection("custom correction", {
          correctionStrongPatterns: ["^custom"],
          correctionNegativePatterns: ["^custom correction$"],
        }),
        false,
      );
    });

    it("uses custom directive words for weak patterns", () => {
      assert.strictEqual(
        isCorrection("no, shipit now", { correctionDirectiveWords: ["shipit"] }),
        true,
      );
      assert.strictEqual(
        isCorrection("no, use yarn", { correctionDirectiveWords: ["shipit"] }),
        false,
      );
    });

    it("ignores invalid custom regex entries and keeps valid entries", () => {
      assert.strictEqual(
        isCorrection("custom correction", { correctionStrongPatterns: ["bad(", "^custom"] }),
        true,
      );
    });

    it("treats explicit empty or all-invalid pattern arrays as empty", () => {
      assert.strictEqual(
        isCorrection("don't do that", { correctionStrongPatterns: [] }),
        false,
      );
      assert.strictEqual(
        isCorrection("don't do that", { correctionStrongPatterns: ["bad("] }),
        false,
      );
    });
  });
});

function registerCorrectionDetector(
  pi: Parameters<typeof setupCorrectionDetector>[0],
  store: Parameters<typeof setupCorrectionDetector>[1],
  projectStore: Parameters<typeof setupCorrectionDetector>[2],
  config: Parameters<typeof setupCorrectionDetector>[3],
  dbManager?: Parameters<typeof setupCorrectionDetector>[5],
  projectName?: Parameters<typeof setupCorrectionDetector>[6],
) {
  setupCorrectionDetector(pi, store, projectStore, config, updateGate, dbManager, projectName);
}

// ─── Handler behavior tests ───

describe("setupCorrectionDetector handler", () => {
  let handlers: Record<string, Array<(event: unknown, ctx: unknown) => Promise<void> | void>>;
  let notifyCalls: Array<{ msg: string; level: string }>;
  let tmpDir: string;
  let dbManager: DatabaseManager;

  function createMockPi() {
    const pi = {
      on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) => {
        handlers[event] = handlers[event] || [];
        handlers[event].push(handler);
      },
      registerTool: () => {},
      registerCommand: () => {},
    };
    assert.ok(!("exec" in pi), "mock pi must not have exec");
    return pi as unknown as import("@oh-my-pi/pi-coding-agent/extensibility/extensions/types").ExtensionAPI;
  }

  const mockStore = {
    getMemoryEntries: () => ["existing entry"],
    getUserEntries: () => [],
  } as unknown as import("../../src/store/memory-store.js").MemoryStore;

  const config = {
    correctionDetection: true,
    nudgeInterval: 10,
    reviewEnabled: false,
    memoryCharLimit: 5000,
    userCharLimit: 5000,
    projectCharLimit: 5000,
    flushOnCompact: false,
    flushOnShutdown: false,
    flushMinTurns: 6,
    autoConsolidate: false,
    nudgeToolCalls: 15,
  } as unknown as import("../../src/types.js").MemoryConfig;

  function makeCtx(branch: unknown[] = []) {
    return {
      sessionManager: { getBranch: () => branch },
      signal: undefined,
      ui: {
        notify: (msg: string, level: string) => {
          notifyCalls.push({ msg, level });
        },
      },
      model: undefined,
      modelRegistry: {
        getApiKey: async () => undefined,
        getAll: () => [],
      },
    };
  }

  function fireMessageEnd(role: string, text: string) {
    const h = handlers["message_end"];
    if (!h) throw new Error("No message_end handler registered");
    const ctx = makeCtx();
    for (const fn of h) {
      fn({ message: { role, content: [{ type: "text", text }] } }, ctx);
    }
  }

  function fireTurnEnd(branch: unknown[] = []) {
    const h = handlers["turn_end"];
    if (!h) throw new Error("No turn_end handler registered");
    const ctx = makeCtx(branch);
    for (const fn of h) {
      fn({}, ctx);
    }
    return ctx;
  }

  function flushMicrotasks(): Promise<void> {
    return Promise.resolve().then(() => Promise.resolve());
  }

  beforeEach(() => {
    handlers = {};
    notifyCalls = [];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "correction-detector-test-"));
    dbManager = new DatabaseManager(tmpDir);
    updateGate = new MemoryUpdateGate();
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not register handlers when correctionDetection is false", () => {
    const pi = createMockPi();
    const disabledConfig = { ...config, correctionDetection: false };
    registerCorrectionDetector(pi, mockStore, null, disabledConfig);

    assert.strictEqual(Object.keys(handlers).length, 0, "no handlers should be registered when disabled");
  });

  it("registers message_end and turn_end handlers when enabled", () => {
    const pi = createMockPi();
    registerCorrectionDetector(pi, mockStore, null, config);

    assert.ok(handlers["message_end"], "message_end handler should be registered");
    assert.ok(handlers["turn_end"], "turn_end handler should be registered");
  });

  it("fires the correction review pipeline when a correction is detected", async () => {
    const pi = createMockPi();
    registerCorrectionDetector(pi, mockStore, null, config);

    const branch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "don't do that" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    ];

    fireMessageEnd("user", "don't do that");
    fireTurnEnd(branch);
    await flushMicrotasks();

    const detectionNotify = notifyCalls.find((c) => c.msg.includes("Correction detected"));
    assert.ok(detectionNotify, "should notify that a correction was detected");
  });

  it("does NOT trigger the correction pipeline on normal messages", async () => {
    const pi = createMockPi();
    registerCorrectionDetector(pi, mockStore, null, config);

    fireMessageEnd("user", "looks good");
    fireTurnEnd([]);
    await flushMicrotasks();

    const detectionNotify = notifyCalls.find((c) => c.msg.includes("Correction detected"));
    assert.strictEqual(detectionNotify, undefined, "should NOT notify for normal messages");
  });

  it("rate limits: does not trigger on consecutive corrections within 3 turns", async () => {
    const pi = createMockPi();
    registerCorrectionDetector(pi, mockStore, null, config);

    fireMessageEnd("user", "don't do that");
    fireTurnEnd([]);
    await flushMicrotasks();

    assert.ok(
      notifyCalls.some((c) => c.msg.includes("Correction detected")),
      "first correction should trigger detection",
    );

    notifyCalls = [];
    fireMessageEnd("user", "not like that");
    fireTurnEnd([]);
    await flushMicrotasks();

    assert.strictEqual(notifyCalls.length, 0, "second correction should be rate-limited");
  });

  it("rate limits: triggers again after 3 turns have elapsed", async () => {
    const pi = createMockPi();
    registerCorrectionDetector(pi, mockStore, null, config);

    fireMessageEnd("user", "don't do that");
    fireTurnEnd([]);
    await flushMicrotasks();
    assert.ok(notifyCalls.some((c) => c.msg.includes("Correction detected")));

    notifyCalls = [];
    fireMessageEnd("user", "ok");
    fireTurnEnd([]);
    await flushMicrotasks();
    fireMessageEnd("user", "ok");
    fireTurnEnd([]);
    await flushMicrotasks();
    fireMessageEnd("user", "ok");
    fireTurnEnd([]);
    await flushMicrotasks();

    notifyCalls = [];
    fireMessageEnd("user", "not like that");
    fireTurnEnd([]);
    await flushMicrotasks();

    assert.ok(
      notifyCalls.some((c) => c.msg.includes("Correction detected")),
      "correction should trigger again after 3-turn cooldown",
    );
  });

  it("saves a failure memory entry when a correction is detected", async () => {
    const pi = createMockPi();
    let addFailureCalled = false;
    let addFailureArgs: { content: string; metadata: unknown } | null = null;
    const correctionStore = {
      getMemoryEntries: () => ["existing entry"],
      getUserEntries: () => [],
      addFailure: async (content: string, metadata: unknown) => {
        addFailureCalled = true;
        addFailureArgs = { content, metadata };
        return { success: true, target: "failure", entry_count: 1, message: "Failure memory saved: correction" };
      },
    } as unknown as import("../../src/store/memory-store.js").MemoryStore;

    registerCorrectionDetector(pi, correctionStore, null, config, dbManager);

    const branch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "no, use pnpm instead" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    ];

    fireMessageEnd("user", "no, use pnpm instead");
    fireTurnEnd(branch);
    await flushMicrotasks();

    assert.ok(addFailureCalled, "store.addFailure should be called on correction");
    assert.ok(addFailureArgs, "addFailure args should be captured");
    if (!addFailureArgs) throw new Error("Expected addFailure args");
    assert.match(addFailureArgs.content, /use pnpm instead/);
  });

  it("syncs the failure memory into SQLite with the correction category", async () => {
    const pi = createMockPi();
    const correctionStore = {
      getMemoryEntries: () => ["existing entry"],
      getUserEntries: () => [],
      addFailure: async () => ({ success: true, target: "failure", entry_count: 1, message: "Failure memory saved: correction" }),
    } as unknown as import("../../src/store/memory-store.js").MemoryStore;

    registerCorrectionDetector(pi, correctionStore, null, config, dbManager);

    const branch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "no, use pnpm instead" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    ];

    fireMessageEnd("user", "no, use pnpm instead");
    fireTurnEnd(branch);
    await flushMicrotasks();
    await flushMicrotasks();

    const failures = getMemories(dbManager, { target: "failure" });
    assert.strictEqual(failures.length, 1);
    assert.match(failures[0].content, /use pnpm instead/);
    assert.strictEqual(failures[0].category, "correction");
  });

  it("syncs project correction saves into SQLite with project scope", async () => {
    const pi = createMockPi();
    const correctionStore = {
      getMemoryEntries: () => ["existing entry"],
      getUserEntries: () => [],
      addFailure: async () => ({ success: true, target: "failure", entry_count: 1, message: "Failure memory saved: correction" }),
    } as unknown as import("../../src/store/memory-store.js").MemoryStore;
    const projectStore = {
      getMemoryEntries: () => ["existing project entry"],
    } as unknown as import("../../src/store/memory-store.js").MemoryStore;

    registerCorrectionDetector(pi, correctionStore, projectStore, config, dbManager, "project-a");

    const branch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "no, use pnpm in this repo" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    ];

    fireMessageEnd("user", "no, use pnpm in this repo");
    fireTurnEnd(branch);
    await flushMicrotasks();
    await flushMicrotasks();

    const projectFailures = getMemories(dbManager, { target: "failure", project: "project-a" });
    assert.strictEqual(projectFailures.length, 1);
    assert.match(projectFailures[0].content, /use pnpm in this repo/);
    assert.match(projectFailures[0].content, /Project: project-a/);
    assert.strictEqual(projectFailures[0].category, "correction");
  });

  it("does not break correction handling when SQLite sync fails", async () => {
    const pi = createMockPi();
    let addFailureCalls = 0;
    const correctionStore = {
      getMemoryEntries: () => ["existing entry"],
      getUserEntries: () => [],
      addFailure: async () => {
        addFailureCalls++;
        return { success: true, target: "failure", entry_count: 1, message: "Failure memory saved: correction" };
      },
    } as unknown as import("../../src/store/memory-store.js").MemoryStore;

    const failingDbManager = {
      getDb: () => {
        throw new Error("sqlite unavailable");
      },
    } as unknown as DatabaseManager;

    registerCorrectionDetector(pi, correctionStore, null, config, failingDbManager);

    const branch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "no, use yarn instead" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    ];

    fireMessageEnd("user", "no, use yarn instead");
    fireTurnEnd(branch);
    await flushMicrotasks();

    assert.strictEqual(addFailureCalls, 1, "Markdown correction save should still happen");
    assert.ok(
      notifyCalls.some((c) => c.msg.includes("Correction detected")),
      "correction detection should still run",
    );
  });
});
