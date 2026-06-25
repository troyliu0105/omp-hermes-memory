import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkScopeViolation, scopeViolationMessage } from "../../src/store/scope-guard.js";

describe("checkScopeViolation", () => {
  // ── Should flag project-specific content (English) ────────────────

  it("flags a file path", () => {
    const r = checkScopeViolation("Config lives at /home/troy/.omp/config.yml");
    assert.equal(r.violated, true);
    if (r.violated) assert.ok(r.detectedSignals.includes("file path"));
  });

  it("flags a source path with extension", () => {
    const r = checkScopeViolation("The bug is in src/store/memory-store.ts");
    assert.equal(r.violated, true);
  });

  it("flags a code identifier (function/class/const)", () => {
    const r = checkScopeViolation("We added a function resolveAgentRoot() to handle paths");
    assert.equal(r.violated, true);
  });

  it("flags a module specifier (@scope/pkg)", () => {
    const r = checkScopeViolation("It depends on @oh-my-pi/pi-coding-agent types");
    assert.equal(r.violated, true);
  });

  it("flags a semantic version", () => {
    const r = checkScopeViolation("Upgraded to v0.8.4 last week");
    assert.equal(r.violated, true);
  });

  it("flags 'this repo' self-reference", () => {
    const r = checkScopeViolation("This repo uses optimistic concurrency, not lock files");
    assert.equal(r.violated, true);
  });

  it("flags a config artifact name", () => {
    const r = checkScopeViolation("Settings are in wrangler.toml at the root");
    assert.equal(r.violated, true);
  });

  it("flags a build command", () => {
    const r = checkScopeViolation("Run npm run build to compile");
    assert.equal(r.violated, true);
  });

  // ── Should flag project-specific content (Chinese) ────────────────

  it("flags Chinese project self-reference (本项目)", () => {
    const r = checkScopeViolation("本项目使用 S3 对象存储，不是本地 markdown");
    assert.equal(r.violated, true);
  });

  it("flags Chinese project self-reference (这个仓库)", () => {
    const r = checkScopeViolation("这个仓库的测试用 tsx 运行");
    assert.equal(r.violated, true);
  });

  it("flags Chinese content with a file path", () => {
    const r = checkScopeViolation("配置文件在 ~/.omp/agent/config.yml 里");
    assert.equal(r.violated, true);
  });

  it("flags mixed Chinese + version + config", () => {
    const r = checkScopeViolation("我们在 v0.8.4 版本的 config.toml 里改了去重逻辑");
    assert.equal(r.violated, true);
  });

  // ── Should NOT flag legitimate global/user content ────────────────

  it("does not flag a simple user preference", () => {
    const r = checkScopeViolation("Prefers systematic, methodical troubleshooting");
    assert.equal(r.violated, false);
  });

  it("does not flag a person-level habit", () => {
    const r = checkScopeViolation("Always responds in Chinese or English");
    assert.equal(r.violated, false);
  });

  it("does not flag a generic environment fact", () => {
    const r = checkScopeViolation("No python on PATH here; use python3 instead");
    assert.equal(r.violated, false);
  });

  it("does not flag a generic tool quirk", () => {
    const r = checkScopeViolation("Bun top-level await works directly without async wrappers");
    assert.equal(r.violated, false);
  });

  it("does not flag a short user identity note", () => {
    const r = checkScopeViolation("User is named Troy, works as a backend engineer");
    assert.equal(r.violated, false);
  });

  it("does not flag a generic communication-style preference (Chinese)", () => {
    const r = checkScopeViolation("用户喜欢简洁直接的回答风格");
    assert.equal(r.violated, false);
  });
});

describe("scopeViolationMessage", () => {
  it("names the target file and suggests project", () => {
    const msg = scopeViolationMessage("user", ["file path", "version number"]);
    assert.match(msg, /USER\.md/);
    assert.match(msg, /target="project"/);
    assert.match(msg, /file path, version number/);
  });

  it("uses MEMORY.md label for the memory target", () => {
    const msg = scopeViolationMessage("memory", ["config artifact"]);
    assert.match(msg, /global MEMORY\.md/);
  });
});
