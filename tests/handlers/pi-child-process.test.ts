import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildChildPiPromptArgs, execChildPrompt } from "../../src/handlers/pi-child-process.js";

describe("buildChildPiPromptArgs", () => {
  it("keeps the current child pi behavior when no overrides are configured", () => {
    assert.deepStrictEqual(
      buildChildPiPromptArgs("hello", {}),
      ["-p", "--no-session", "hello"],
    );
  });

  it("adds a model override and defaults thinking to off", () => {
    assert.deepStrictEqual(
      buildChildPiPromptArgs("hello", { llmModelOverride: "openrouter/deepseek/deepseek-v4-flash" }),
      ["-p", "--no-session", "--model", "openrouter/deepseek/deepseek-v4-flash", "--thinking", "off", "hello"],
    );
  });

  it("allows thinking overrides without a model override", () => {
    assert.deepStrictEqual(
      buildChildPiPromptArgs("hello", { llmThinkingOverride: "low" }),
      ["-p", "--no-session", "--thinking", "low", "hello"],
    );
  });
});

describe("execChildPrompt", () => {
  it("retries once without overrides when requested and the override subprocess fails for model resolution reasons", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const pi = {
      exec: async (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        if (calls.length === 1) {
          return { code: 1, stdout: "", stderr: "model not found" };
        }
        return { code: 0, stdout: "ok", stderr: "" };
      },
    };

    const result = await execChildPrompt(pi as any, "hello", {
      llmModelOverride: "openrouter/deepseek/deepseek-v4-flash",
    }, {
      timeoutMs: 30000,
      retryWithoutOverrides: true,
    });

    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(calls.map((call) => call.args), [
      ["-p", "--no-session", "--model", "openrouter/deepseek/deepseek-v4-flash", "--thinking", "off", "hello"],
      ["-p", "--no-session", "hello"],
    ]);
  });

  it("does not retry generic non-zero child failures that are unrelated to override resolution", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const pi = {
      exec: async (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        return { code: 1, stdout: "", stderr: "memory tool returned no changes" };
      },
    };

    const result = await execChildPrompt(pi as any, "hello", {
      llmModelOverride: "openrouter/deepseek/deepseek-v4-flash",
    }, {
      timeoutMs: 30000,
      retryWithoutOverrides: true,
    });

    assert.strictEqual(result.code, 1);
    assert.strictEqual(calls.length, 1);
  });

  it("does not retry generic thrown errors that are unrelated to override resolution", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const pi = {
      exec: async (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        throw new Error("timed out waiting for child process");
      },
    };

    await assert.rejects(
      () => execChildPrompt(pi as any, "hello", {
        llmModelOverride: "openrouter/deepseek/deepseek-v4-flash",
      }, {
        timeoutMs: 30000,
        retryWithoutOverrides: true,
      }),
      /timed out waiting for child process/,
    );

    assert.strictEqual(calls.length, 1);
  });

  it("does not retry when retryWithoutOverrides is false", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const pi = {
      exec: async (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        return { code: 1, stdout: "", stderr: "model not found" };
      },
    };

    const result = await execChildPrompt(pi as any, "hello", {
      llmModelOverride: "openrouter/deepseek/deepseek-v4-flash",
    }, {
      timeoutMs: 30000,
      retryWithoutOverrides: false,
    });

    assert.strictEqual(result.code, 1);
    assert.strictEqual(calls.length, 1);
  });
});
