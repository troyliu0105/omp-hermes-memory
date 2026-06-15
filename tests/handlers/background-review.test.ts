/**
 * Background review tests — trigger logic for the in-process LLM review.
 *
 * The LLM call itself is fire-and-forget and uses a lazy import of
 * `completeSimple` which cannot run under tsx. Tests focus on trigger
 * logic: turn counting, tool-call counting, idle timer, rate limiting,
 * and notification behavior. The fire-and-forget review catches its own
 * errors, so tests observe behavior through notifications, not exec calls.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { setupBackgroundReview } from "../../src/handlers/background-review.js";
import { MemoryUpdateGate } from "../../src/handlers/memory-update-gate.js";
// ─── Mock infrastructure ───

interface CallLog {
  handler: string;
  args: unknown[];
}

let handlers: Record<string, Function[]>;
let notifyCalls: { msg: string; level: string }[];

let updateGate: MemoryUpdateGate;

function createMockPi() {
  return {
    on: (event: string, handler: Function) => {
      handlers[event] = handlers[event] || [];
      handlers[event].push(handler);
    },
    registerTool: () => {},
    registerCommand: () => {},
  } as Parameters<typeof setupBackgroundReview>[0];
}

function makeBranch(numMessages: number) {
  return Array.from({ length: numMessages }, (_, i) => ({
    type: "message",
    message: {
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `Message number ${i} with some real content here` }],
      timestamp: i,
    },
  }));
}

function makeCtx(branch: unknown[] = [], overrides: Record<string, unknown> = {}) {
  return {
    sessionManager: { getBranch: () => branch },
    signal: undefined,
    ui: {
      notify: (msg: string, level: string) => {
        notifyCalls.push({ msg, level });
      },
    },
    model: undefined,
    modelRegistry: { getApiKey: async () => undefined, getAll: () => [] },
    ...overrides,
  };
}

const defaultConfig = {
  reviewEnabled: true,
  nudgeInterval: 10,
  reviewRecentMessages: 0,
  flushMinTurns: 6,
  flushRecentMessages: 0,
  flushOnCompact: true,
  flushOnShutdown: true,
  memoryCharLimit: 5000,
  userCharLimit: 5000,
  projectCharLimit: 5000,
  autoConsolidate: true,
  correctionDetection: true,
  failureInjectionEnabled: true,
  failureInjectionMaxAgeDays: 7,
  failureInjectionMaxEntries: 5,
  nudgeToolCalls: 15,
};

const mockStore = {
  getMemoryEntries: () => ["existing memory entry"],
  getUserEntries: () => ["existing user entry"],
} as Parameters<typeof setupBackgroundReview>[1];

function registerBackgroundReview(
  pi: Parameters<typeof setupBackgroundReview>[0],
  config: typeof defaultConfig,
) {
  setupBackgroundReview(pi, mockStore, null, config, updateGate);
}

function fireMessageEnd(role: string) {
  const h = handlers["message_end"];
  if (!h) throw new Error("No message_end handler registered");
  for (const fn of h) {
    fn({ message: { role, content: [{ type: "text", text: "hi" }] } }, makeCtx());
  }
}

function fireTurnEnd(branch: unknown[] = makeBranch(10), ctxOverrides: Record<string, unknown> = {}) {
  const h = handlers["turn_end"];
  if (!h) throw new Error("No turn_end handler registered");
  const ctx = makeCtx(branch, ctxOverrides);
  // Extract the last assistant message from the branch to pass as event.message
  let assistantMessage: Record<string, unknown> | undefined;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as Record<string, unknown>;
    if (entry && typeof entry === "object" && entry.type === "message") {
      const msg = entry.message as Record<string, unknown> | undefined;
      if (msg?.role === "assistant") {
        assistantMessage = msg;
        break;
      }
    }
  }
  const event = assistantMessage ? { message: assistantMessage } : {};
  for (const fn of h) {
    fn(event, ctx);
  }
  return ctx;
}

/** Flush microtasks so fire-and-forget .then/.catch handlers run. */
function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then(() => Promise.resolve());
}

// ─── Tests ───

describe("setupBackgroundReview", () => {
  beforeEach(() => {
    handlers = {};
    updateGate = new MemoryUpdateGate();
    notifyCalls = [];
  });

  it("increments user turn count on message_end for user messages", () => {
    const pi = createMockPi();
    registerBackgroundReview(pi, defaultConfig);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    // 3 user turns + 10 turn_end events → triggers review
    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }

    const trigger = notifyCalls.find((n) => n.msg.includes("Background review triggered"));
    assert.ok(trigger, "should trigger review with 3 user turns and 10 turn_end events");
  });

  it("does NOT trigger review when reviewEnabled is false", async () => {
    const config = { ...defaultConfig, reviewEnabled: false };
    const pi = createMockPi();
    registerBackgroundReview(pi, config);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    for (let i = 0; i < 15; i++) {
      fireTurnEnd();
    }
    await flushMicrotasks();

    const trigger = notifyCalls.find((n) => n.msg.includes("Background review triggered"));
    assert.strictEqual(trigger, undefined, "no trigger when reviewEnabled is false");
  });

  it("does NOT trigger review with fewer than 3 user turns", async () => {
    const pi = createMockPi();
    registerBackgroundReview(pi, defaultConfig);

    fireMessageEnd("user");
    fireMessageEnd("user");

    for (let i = 0; i < 15; i++) {
      fireTurnEnd();
    }
    await flushMicrotasks();

    const trigger = notifyCalls.find((n) => n.msg.includes("Background review triggered"));
    assert.strictEqual(trigger, undefined, "no trigger with only 2 user turns");
  });

  it("does NOT trigger for short conversations (< 4 message parts)", async () => {
    const pi = createMockPi();
    registerBackgroundReview(pi, defaultConfig);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    const shortBranch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
    ];

    for (let i = 0; i < 10; i++) {
      fireTurnEnd(shortBranch);
    }
    await flushMicrotasks();

    const trigger = notifyCalls.find((n) => n.msg.includes("Background review triggered"));
    assert.strictEqual(trigger, undefined, "no trigger for short conversations");
  });

  it("resets turn counter after review triggers", async () => {
    const pi = createMockPi();
    registerBackgroundReview(pi, defaultConfig);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await flushMicrotasks();
    await flushMicrotasks();

    const firstTriggerCount = notifyCalls.filter((n) => n.msg.includes("Background review triggered")).length;
    assert.strictEqual(firstTriggerCount, 1, "first review triggered once");

    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await flushMicrotasks();
    await flushMicrotasks();

    const secondTriggerCount = notifyCalls.filter((n) => n.msg.includes("Background review triggered")).length;
    assert.strictEqual(secondTriggerCount, 2, "second review triggered after counter reset");
  });

  it("skips background review while another memory update is active", async () => {
    const pi = createMockPi();
    registerBackgroundReview(pi, defaultConfig);

    const blocker = Promise.withResolvers<void>();
    void updateGate.runExclusive(async () => {
      await blocker.promise;
    });
    await flushMicrotasks();

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");
    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await flushMicrotasks();

    const trigger = notifyCalls.find((n) => n.msg.includes("Background review triggered"));
    assert.strictEqual(trigger, undefined, "background review should skip while gate is busy");

    blocker.resolve();
    await flushMicrotasks();
  });

  it("does NOT crash agent when review call fails", async () => {
    const pi = createMockPi();
    registerBackgroundReview(pi, defaultConfig);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    // The LLM call will fail (no model), but it's caught internally.
    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await flushMicrotasks();

    // The trigger notification should fire (pre-call), and a failure warning
    // should follow once the fire-and-forget promise rejects.
    const trigger = notifyCalls.find((n) => n.msg.includes("Background review triggered"));
    assert.ok(trigger, "trigger notification emitted");
  });

  it("assistant message_end does NOT increment user turn count", async () => {
    const pi = createMockPi();
    registerBackgroundReview(pi, defaultConfig);

    fireMessageEnd("assistant");
    fireMessageEnd("assistant");
    fireMessageEnd("assistant");

    for (let i = 0; i < 15; i++) {
      fireTurnEnd();
    }
    await flushMicrotasks();

    const trigger = notifyCalls.find((n) => n.msg.includes("Background review triggered"));
    assert.strictEqual(trigger, undefined, "no trigger — no user messages");
  });

  // ─── Tool-call-aware nudge tests ───

  it("triggers on tool call count threshold even with low turn count", async () => {
    const config = { ...defaultConfig, nudgeToolCalls: 5 };
    const pi = createMockPi();
    registerBackgroundReview(pi, config);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    const branchWithToolCalls = [
      ...makeBranch(4),
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc1", name: "read", arguments: {} },
            { type: "toolCall", id: "tc2", name: "bash", arguments: {} },
            { type: "toolCall", id: "tc3", name: "edit", arguments: {} },
            { type: "toolCall", id: "tc4", name: "read", arguments: {} },
            { type: "toolCall", id: "tc5", name: "bash", arguments: {} },
          ],
          timestamp: 1,
        },
      },
    ];

    fireTurnEnd(branchWithToolCalls);
    fireTurnEnd(branchWithToolCalls);
    await flushMicrotasks();

    const trigger = notifyCalls.find((n) => n.msg.includes("Background review triggered"));
    assert.ok(trigger, "should trigger due to tool call threshold");
    assert.ok(trigger.msg.includes("tool calls"), "trigger message names tool calls");
  });

  it("does not trigger when neither threshold is met", async () => {
    const config = { ...defaultConfig, nudgeToolCalls: 15 };
    const pi = createMockPi();
    registerBackgroundReview(pi, config);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    const branchWithFewToolCalls = [
      ...makeBranch(4),
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc1", name: "read", arguments: {} },
            { type: "toolCall", id: "tc2", name: "bash", arguments: {} },
          ],
          timestamp: 1,
        },
      },
    ];

    for (let i = 0; i < 5; i++) {
      fireTurnEnd(branchWithFewToolCalls);
    }
    await flushMicrotasks();

    const trigger = notifyCalls.find((n) => n.msg.includes("Background review triggered"));
    assert.strictEqual(trigger, undefined, "no trigger when neither threshold met");
  });

  it("ignores text blocks when counting tool calls", async () => {
    const config = { ...defaultConfig, nudgeToolCalls: 3, nudgeInterval: 999 };
    const pi = createMockPi();
    registerBackgroundReview(pi, config);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    // Text-only messages — no toolCall blocks
    for (let i = 0; i < 5; i++) {
      fireTurnEnd(makeBranch(10));
    }
    await flushMicrotasks();

    const trigger = notifyCalls.find((n) => n.msg.includes("Background review triggered"));
    assert.strictEqual(trigger, undefined, "no trigger — no toolCall blocks, turn threshold not met");
  });

  it("falls back gracefully if getBranch throws", async () => {
    const config = { ...defaultConfig, nudgeToolCalls: 3 };
    const pi = createMockPi();
    registerBackgroundReview(pi, config);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    const crashCtx = {
      sessionManager: { getBranch: () => { throw new Error("session expired"); } },
      signal: undefined,
      ui: { notify: () => {} },
      model: undefined,
      modelRegistry: { getApiKey: async () => undefined, getAll: () => [] },
    };

    const h = handlers["turn_end"];
    for (let i = 0; i < 10; i++) {
      for (const fn of h) {
        fn({}, crashCtx);
      }
    }
    await flushMicrotasks();

    assert.ok(true, "no crash when getBranch throws");
  });

  // ─── Notification tests ───

  it("emits an info notification when review triggers", async () => {
    const pi = createMockPi();
    registerBackgroundReview(pi, defaultConfig);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");
    for (let i = 0; i < 10; i++) fireTurnEnd();
    await flushMicrotasks();

    const trigger = notifyCalls.find((n) => n.msg.includes("Background review triggered"));
    assert.ok(trigger, "emits a trigger notification");
    assert.strictEqual(trigger.level, "info");
    assert.ok(trigger.msg.includes("10 turns"), "trigger message names the reason");
  });

  it("names tool-calls as the reason when that threshold fires", async () => {
    const config = { ...defaultConfig, nudgeInterval: 999, nudgeToolCalls: 5 };
    const pi = createMockPi();
    registerBackgroundReview(pi, config);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    const branch = makeBranch(10);
    const assistantMsg = { role: "assistant", content: [
      { type: "toolCall" }, { type: "toolCall" }, { type: "toolCall" },
    ] };
    const h = handlers["turn_end"];
    for (let i = 0; i < 2; i++) {
      for (const fn of h) fn({ message: assistantMsg }, makeCtx(branch));
    }
    await flushMicrotasks();

    const trigger = notifyCalls.find((n) => n.msg.includes("tool calls"));
    assert.ok(trigger, "trigger notification names tool calls as the reason");
  });
});
