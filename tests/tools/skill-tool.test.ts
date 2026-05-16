/**
 * Unit tests for skill tool registration and execute function.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { registerSkillTool } from "../../src/tools/skill-tool.js";
import { SkillStore } from "../../src/store/skill-store.js";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";

let ROOT_DIR = "";
let GLOBAL_SKILLS_DIR = "";
let PROJECT_SKILLS_DIR = "";

async function makeStore(withProject = true): Promise<SkillStore> {
  ROOT_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "pi-skill-tool-test-"));
  GLOBAL_SKILLS_DIR = path.join(ROOT_DIR, "global-skills");
  PROJECT_SKILLS_DIR = path.join(ROOT_DIR, "project-skills");
  await fs.mkdir(GLOBAL_SKILLS_DIR, { recursive: true });
  if (withProject) await fs.mkdir(PROJECT_SKILLS_DIR, { recursive: true });

  return new SkillStore({
    globalSkillsDir: GLOBAL_SKILLS_DIR,
    projectSkillsDir: withProject ? PROJECT_SKILLS_DIR : null,
    projectName: withProject ? "demo-project" : null,
    legacySkillsDir: path.join(ROOT_DIR, "legacy-skills"),
    migrationSentinelPath: path.join(ROOT_DIR, ".skill-migration"),
  });
}

async function cleanup(): Promise<void> {
  try {
    await fs.rm(ROOT_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

describe("registerSkillTool", () => {
  it("registers tool with name 'skill'", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;

    const store = await makeStore();
    registerSkillTool(mockPi, store);
    await cleanup();

    assert.strictEqual(captured.name, "skill");
    assert.strictEqual(captured.label, "Skill");
    assert.ok(captured.description.length > 0);
    assert.ok(captured.promptSnippet.length > 0);
    assert.ok(Array.isArray(captured.promptGuidelines));
    assert.ok(captured.parameters);
  });

  it("create requires name, description, content", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;

    const store = await makeStore();
    registerSkillTool(mockPi, store);

    let result = await captured.execute("tc-1", { action: "create", description: "desc", content: "body" }, undefined, undefined, undefined);
    assert.strictEqual(JSON.parse(result.content[0].text).success, false);

    result = await captured.execute("tc-1", { action: "create", name: "test", content: "body" }, undefined, undefined, undefined);
    assert.strictEqual(JSON.parse(result.content[0].text).success, false);

    result = await captured.execute("tc-1", { action: "create", name: "test", description: "desc" }, undefined, undefined, undefined);
    assert.strictEqual(JSON.parse(result.content[0].text).success, false);

    await cleanup();
  });

  it("create succeeds with all params and returns skill_id", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;

    const store = await makeStore();
    registerSkillTool(mockPi, store);

    const result = await captured.execute("tc-1", {
      action: "create",
      name: "test-skill",
      description: "A test skill",
      content: "## Procedure\n1. Do it",
    }, undefined, undefined, undefined);

    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.success, true);
    assert.strictEqual(parsed.skillId, "global:test-skill");
    assert.strictEqual(parsed.scope, "global");

    await cleanup();
  });

  it("create supports explicit project scope", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;

    const store = await makeStore();
    registerSkillTool(mockPi, store);

    const result = await captured.execute("tc-1", {
      action: "create",
      name: "release-app",
      description: "Release this app",
      scope: "project",
      content: "## Procedure\n1. Run pnpm build",
    }, undefined, undefined, undefined);

    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.success, true);
    assert.strictEqual(parsed.skillId, "project:demo-project:release-app");
    assert.strictEqual(parsed.scope, "project");

    await cleanup();
  });

  it("view without skill_id lists all skills", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;

    const store = await makeStore();
    await store.create("skill-a", "First", "body a");
    await store.create("skill-b", "Second", "body b", "project");
    registerSkillTool(mockPi, store);

    const result = await captured.execute("tc-1", { action: "view" }, undefined, undefined, undefined);
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.success, true);
    assert.strictEqual(parsed.skills.length, 2);

    await cleanup();
  });

  it("view with skill_id returns full document", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;

    const store = await makeStore();
    const created = await store.create("my-skill", "A skill", "## Body content here");
    registerSkillTool(mockPi, store);

    const result = await captured.execute("tc-1", { action: "view", skill_id: created.skillId }, undefined, undefined, undefined);
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.success, true);
    assert.strictEqual(parsed.name, "my-skill");
    assert.ok(parsed.body.includes("## Body content here"));

    await cleanup();
  });

  it("view with invalid skill_id returns error", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;

    const store = await makeStore();
    registerSkillTool(mockPi, store);

    const result = await captured.execute("tc-1", { action: "view", skill_id: "global:missing" }, undefined, undefined, undefined);
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.success, false);
    assert.ok(parsed.error.includes("not found"));

    await cleanup();
  });

  it("patch requires skill_id, section, content", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;

    const store = await makeStore();
    registerSkillTool(mockPi, store);

    let result = await captured.execute("tc-1", { action: "patch", section: "Procedure", content: "new" }, undefined, undefined, undefined);
    assert.strictEqual(JSON.parse(result.content[0].text).success, false);

    result = await captured.execute("tc-1", { action: "patch", skill_id: "global:test", content: "new" }, undefined, undefined, undefined);
    assert.strictEqual(JSON.parse(result.content[0].text).success, false);

    result = await captured.execute("tc-1", { action: "patch", skill_id: "global:test", section: "Procedure" }, undefined, undefined, undefined);
    assert.strictEqual(JSON.parse(result.content[0].text).success, false);

    await cleanup();
  });

  it("edit requires skill_id", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;

    const store = await makeStore();
    registerSkillTool(mockPi, store);

    const result = await captured.execute("tc-1", { action: "edit", description: "new desc" }, undefined, undefined, undefined);
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.success, false);
    assert.ok(parsed.error.includes("skill_id"));

    await cleanup();
  });

  it("delete requires skill_id", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;

    const store = await makeStore();
    registerSkillTool(mockPi, store);

    const result = await captured.execute("tc-1", { action: "delete" }, undefined, undefined, undefined);
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.success, false);
    assert.ok(parsed.error.includes("skill_id"));

    await cleanup();
  });

  it("unknown action returns error", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;

    const store = await makeStore();
    registerSkillTool(mockPi, store);

    const result = await captured.execute("tc-1", { action: "explode" }, undefined, undefined, undefined);
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.success, false);
    assert.ok(parsed.error.includes("Unknown action"));

    await cleanup();
  });
});
