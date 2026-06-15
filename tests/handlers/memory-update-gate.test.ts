/**
 * Unit tests for per-session memory update serialization.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryUpdateGate } from "../../src/handlers/memory-update-gate.js";

describe("MemoryUpdateGate", () => {
  it("serializes top-level tasks", async () => {
    const gate = new MemoryUpdateGate();
    const first = Promise.withResolvers<void>();
    const order: string[] = [];

    const firstTask = gate.runExclusive(async () => {
      order.push("first:start");
      await first.promise;
      order.push("first:end");
    });

    const secondTask = gate.runExclusive(async () => {
      order.push("second:start");
      order.push("second:end");
    });

    await Promise.resolve();
    await Promise.resolve();
    assert.deepStrictEqual(order, ["first:start"]);
    assert.strictEqual(gate.isBusy(), true);

    first.resolve();
    await firstTask;
    await secondTask;

    assert.deepStrictEqual(order, [
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
    assert.strictEqual(gate.isBusy(), false);
  });

  it("runs re-entrant tasks inline without deadlocking", async () => {
    const gate = new MemoryUpdateGate();
    const order: string[] = [];

    await gate.runExclusive(async () => {
      order.push("outer:start");
      await gate.runExclusive(async () => {
        order.push("inner");
      });
      order.push("outer:end");
    });

    assert.deepStrictEqual(order, ["outer:start", "inner", "outer:end"]);
  });

  it("runIfIdle skips when another top-level task is active", async () => {
    const gate = new MemoryUpdateGate();
    const blocker = Promise.withResolvers<void>();

    const firstTask = gate.runExclusive(async () => {
      await blocker.promise;
      return "first";
    });

    await Promise.resolve();
    await Promise.resolve();

    const skipped = await gate.runIfIdle(async () => "second");
    assert.strictEqual(skipped, undefined);

    blocker.resolve();
    await firstTask;
  });
});
