import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSkillRows,
  confirmDeleteSelectedSkills,
  deleteSelectedSkills,
  filterSkillRows,
  moveSelectedSkills,
  registerSkillsCommand,
  SkillsManagerModal,
  type SkillBatchActionResult,
} from "../../src/handlers/skills-command.js";
import type { SkillIndex, SkillResult } from "../../src/types.js";

const SAMPLE_SKILLS: SkillIndex[] = [
  {
    skillId: "global:debug-typescript-errors",
    scope: "global",
    fileName: "SKILL.md",
    path: "/tmp/global/debug-typescript-errors/SKILL.md",
    name: "debug-typescript-errors",
    displayName: "Debug TypeScript Errors",
    description: "Trace compiler issues step by step",
  },
  {
    skillId: "project:demo-project:deploy-checklist",
    scope: "project",
    fileName: "SKILL.md",
    path: "/tmp/project/deploy-checklist/SKILL.md",
    projectName: "demo-project",
    name: "deploy-checklist",
    displayName: "Deploy Checklist",
    description: "Project release checklist",
  },
];

describe("skills command helpers", () => {
  it("buildSkillRows preserves selected ids", () => {
    const rows = buildSkillRows(SAMPLE_SKILLS, new Set(["project:demo-project:deploy-checklist"]));

    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].selected, false);
    assert.strictEqual(rows[1].selected, true);
    assert.strictEqual(rows[0].searchText.includes("Debug TypeScript Errors"), true);
  });

  it("filterSkillRows uses fuzzy skill-name matching", () => {
    const rows = buildSkillRows(SAMPLE_SKILLS);
    const filtered = filterSkillRows(rows, "dbg ts err");

    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].skillId, "global:debug-typescript-errors");
  });

  it("moveSelectedSkills blocks project moves without an active project", async () => {
    const store = {
      getProjectName: () => null,
      loadIndex: async () => SAMPLE_SKILLS,
      move: async () => ({ success: true } as SkillResult),
    };

    const result = await moveSelectedSkills(store as any, ["global:debug-typescript-errors"], "project");

    assert.strictEqual(result.summaryLines[0], "Move to project is unavailable: no active project detected.");
    assert.deepStrictEqual(result.retainSelectedSkillIds, ["global:debug-typescript-errors"]);
  });

  it("moveSelectedSkills keeps partial successes and retains blocked selection", async () => {
    const moves = new Map<string, SkillResult>([
      [
        "global:debug-typescript-errors",
        {
          success: true,
          skillId: "project:demo-project:debug-typescript-errors",
          scope: "project",
          message: "Skill 'Debug TypeScript Errors' moved to project.",
        },
      ],
      [
        "project:demo-project:deploy-checklist",
        {
          success: false,
          error: "Destination already exists.",
          conflictType: "scope-conflict",
        },
      ],
    ]);

    const refreshed: SkillIndex[] = [
      {
        ...SAMPLE_SKILLS[1],
        skillId: "project:demo-project:debug-typescript-errors",
        name: "debug-typescript-errors",
        displayName: "Debug TypeScript Errors",
        path: "/tmp/project/debug-typescript-errors/SKILL.md",
        description: "Trace compiler issues step by step",
      },
      SAMPLE_SKILLS[1],
    ];

    const store = {
      getProjectName: () => "demo-project",
      loadIndex: async () => refreshed,
      move: async (skillId: string) => moves.get(skillId)!,
    };

    const result = await moveSelectedSkills(
      store as any,
      ["global:debug-typescript-errors", "project:demo-project:deploy-checklist"],
      "project",
    );

    assert.ok(result.summaryLines[0].includes("Moved 1 skill"));
    assert.ok(result.summaryLines.some((line) => line.includes("Blocked 1 skill")));
    assert.deepStrictEqual(result.retainSelectedSkillIds, ["project:demo-project:deploy-checklist"]);
    assert.strictEqual(result.focusSkillId, "project:demo-project:deploy-checklist");
    assert.strictEqual(result.skills.length, 2);
  });

  it("deleteSelectedSkills reports blocked deletes and refreshes skills", async () => {
    const store = {
      loadIndex: async () => [SAMPLE_SKILLS[1]],
      delete: async (skillId: string) => skillId === SAMPLE_SKILLS[0].skillId
        ? { success: true, skillId, scope: "global" as const }
        : { success: false, error: "Skill missing." },
    };

    const result = await deleteSelectedSkills(
      store as any,
      [SAMPLE_SKILLS[0].skillId, SAMPLE_SKILLS[1].skillId],
    );

    assert.ok(result.summaryLines[0].includes("Deleted 1 skill"));
    assert.ok(result.summaryLines.some((line) => line.includes("Blocked 1 skill")));
    assert.deepStrictEqual(result.retainSelectedSkillIds, [SAMPLE_SKILLS[1].skillId]);
  });

  it("moveSelectedSkills treats thrown move errors as blocked items", async () => {
    const store = {
      getProjectName: () => "demo-project",
      loadIndex: async () => SAMPLE_SKILLS,
      move: async (skillId: string) => {
        if (skillId === SAMPLE_SKILLS[0].skillId) {
          throw new Error("permission denied");
        }
        return { success: true, skillId: "global:deploy-checklist", scope: "global" as const };
      },
    };

    const result = await moveSelectedSkills(store as any, [SAMPLE_SKILLS[0].skillId, SAMPLE_SKILLS[1].skillId], "global");

    assert.ok(result.summaryLines.some((line) => line.includes("Blocked 1 skill")));
    assert.ok(result.summaryLines.some((line) => line.includes("permission denied")));
    assert.deepStrictEqual(result.retainSelectedSkillIds, [SAMPLE_SKILLS[0].skillId]);
  });

  it("deleteSelectedSkills treats thrown delete errors as blocked items", async () => {
    const store = {
      loadIndex: async () => SAMPLE_SKILLS,
      delete: async (skillId: string) => {
        if (skillId === SAMPLE_SKILLS[1].skillId) {
          throw new Error("unlink denied");
        }
        return { success: true, skillId, scope: "global" as const };
      },
    };

    const result = await deleteSelectedSkills(store as any, [SAMPLE_SKILLS[0].skillId, SAMPLE_SKILLS[1].skillId]);

    assert.ok(result.summaryLines.some((line) => line.includes("Blocked 1 skill")));
    assert.ok(result.summaryLines.some((line) => line.includes("unlink denied")));
    assert.deepStrictEqual(result.retainSelectedSkillIds, [SAMPLE_SKILLS[1].skillId]);
  });

  it("confirmDeleteSelectedSkills keeps selection when user cancels", async () => {
    let prompts = 0;
    const store = {
      loadIndex: async () => SAMPLE_SKILLS,
      delete: async () => ({ success: true }),
    };

    const result = await confirmDeleteSelectedSkills(
      async () => {
        prompts++;
        return false;
      },
      store as any,
      [SAMPLE_SKILLS[0].skillId],
    );

    assert.strictEqual(prompts, 1);
    assert.deepStrictEqual(result.retainSelectedSkillIds, [SAMPLE_SKILLS[0].skillId]);
    assert.strictEqual(result.summaryLines[0], "Delete cancelled.");
  });
});

function createModalHarness() {
  let renderCount = 0;
  return {
    tui: {
      requestRender: () => {
        renderCount++;
      },
      terminal: { rows: 42 },
    },
    theme: {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    },
    getRenderCount: () => renderCount,
  };
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("SkillsManagerModal", () => {
  it("toggles selection and sends selected ids for move action", async () => {
    const harness = createModalHarness();
    const captured: Array<{ scope: string; skillIds: string[] }> = [];

    const modal = new SkillsManagerModal(
      harness.tui as any,
      harness.theme as any,
      buildSkillRows(SAMPLE_SKILLS),
      {
        moveSelected: async (scope, skillIds) => {
          captured.push({ scope, skillIds });
          return { skills: SAMPLE_SKILLS, summaryLines: ["done"] };
        },
        deleteSelected: async () => ({ skills: SAMPLE_SKILLS, summaryLines: ["done"] }),
        close: () => undefined,
        projectName: "demo-project",
      },
    );

    modal.handleInput(" ");
    modal.handleInput("g");
    await nextTick();

    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0].scope, "global");
    assert.deepStrictEqual(captured[0].skillIds, ["global:debug-typescript-errors"]);
  });

  it("supports slash search and typed filtering", () => {
    const harness = createModalHarness();
    const modal = new SkillsManagerModal(
      harness.tui as any,
      harness.theme as any,
      buildSkillRows(SAMPLE_SKILLS),
      {
        moveSelected: async () => ({ skills: SAMPLE_SKILLS, summaryLines: ["done"] }),
        deleteSelected: async () => ({ skills: SAMPLE_SKILLS, summaryLines: ["done"] }),
        close: () => undefined,
        projectName: "demo-project",
      },
    );

    modal.handleInput("/");
    modal.handleInput("z");
    modal.handleInput("z");

    const output = modal.render(100).join("\n");
    assert.ok(output.includes("No skills match the current search."));
  });

  it("redirects printable keys to search from list focus", () => {
    const harness = createModalHarness();
    const modal = new SkillsManagerModal(
      harness.tui as any,
      harness.theme as any,
      buildSkillRows(SAMPLE_SKILLS),
      {
        moveSelected: async () => ({ skills: SAMPLE_SKILLS, summaryLines: ["done"] }),
        deleteSelected: async () => ({ skills: SAMPLE_SKILLS, summaryLines: ["done"] }),
        close: () => undefined,
        projectName: "demo-project",
      },
    );

    modal.handleInput("z");
    const output = modal.render(100).join("\n");
    assert.ok(output.includes("No skills match the current search."));
  });

  it("uses in-modal delete confirmation and cancels with n", () => {
    const harness = createModalHarness();
    let deleteCalls = 0;

    const modal = new SkillsManagerModal(
      harness.tui as any,
      harness.theme as any,
      buildSkillRows(SAMPLE_SKILLS),
      {
        moveSelected: async () => ({ skills: SAMPLE_SKILLS, summaryLines: ["done"] }),
        deleteSelected: async () => {
          deleteCalls++;
          return { skills: SAMPLE_SKILLS, summaryLines: ["deleted"] };
        },
        close: () => undefined,
        projectName: "demo-project",
      },
    );

    modal.handleInput(" ");
    modal.handleInput("d");
    let output = modal.render(100).join("\n");
    assert.ok(output.includes("Press y to confirm or n to cancel"));

    modal.handleInput("n");
    output = modal.render(100).join("\n");
    assert.ok(output.includes("Delete cancelled."));
    assert.strictEqual(deleteCalls, 0);
  });

  it("confirms delete in-modal with y", async () => {
    const harness = createModalHarness();
    const capturedDeletes: string[][] = [];

    const modal = new SkillsManagerModal(
      harness.tui as any,
      harness.theme as any,
      buildSkillRows(SAMPLE_SKILLS),
      {
        moveSelected: async () => ({ skills: SAMPLE_SKILLS, summaryLines: ["done"] }),
        deleteSelected: async (skillIds) => {
          capturedDeletes.push(skillIds);
          return { skills: [SAMPLE_SKILLS[1]], summaryLines: ["deleted"] };
        },
        close: () => undefined,
        projectName: "demo-project",
      },
    );

    modal.handleInput(" ");
    modal.handleInput("d");
    modal.handleInput("y");
    await nextTick();

    assert.strictEqual(capturedDeletes.length, 1);
    assert.deepStrictEqual(capturedDeletes[0], ["global:debug-typescript-errors"]);
  });

  it("stops rendering updates after close during async actions", async () => {
    const harness = createModalHarness();
    let resolveMove: ((result: SkillBatchActionResult) => void) | null = null;
    let closeCount = 0;

    const modal = new SkillsManagerModal(
      harness.tui as any,
      harness.theme as any,
      buildSkillRows(SAMPLE_SKILLS),
      {
        moveSelected: async () => {
          return await new Promise<SkillBatchActionResult>((resolve) => {
            resolveMove = resolve;
          });
        },
        deleteSelected: async () => ({ skills: SAMPLE_SKILLS, summaryLines: ["done"] }),
        close: () => {
          closeCount++;
        },
        projectName: "demo-project",
      },
    );

    modal.handleInput("g");
    modal.handleInput("\u001b");
    assert.strictEqual(closeCount, 1);

    const renderCountBeforeResolve = harness.getRenderCount();
    resolveMove?.({ skills: SAMPLE_SKILLS, summaryLines: ["moved"] });
    await nextTick();

    assert.strictEqual(harness.getRenderCount(), renderCountBeforeResolve);
  });
});

describe("registerSkillsCommand", () => {
  it("falls back to notify output when custom UI is unavailable", async () => {
    const commands: Array<{ name: string; handler: Function }> = [];
    const notifications: Array<{ message: string; severity: string }> = [];
    const pi = {
      registerCommand: (name: string, opts: { handler: Function }) => {
        commands.push({ name, handler: opts.handler });
      },
    };
    const store = {
      loadIndex: async () => SAMPLE_SKILLS,
      getProjectName: () => "demo-project",
    };

    registerSkillsCommand(pi as any, store as any);
    assert.strictEqual(commands.length, 1);

    await commands[0].handler({}, {
      hasUI: false,
      ui: {
        notify: (message: string, severity: string) => notifications.push({ message, severity }),
      },
    });

    assert.strictEqual(notifications.length, 1);
    assert.strictEqual(notifications[0].severity, "info");
    assert.ok(notifications[0].message.includes("Procedural Skills"));
  });

  it("opens a custom modal when interactive UI is available", async () => {
    const commands: Array<{ name: string; handler: Function }> = [];
    let customInvoked = false;
    const pi = {
      registerCommand: (name: string, opts: { handler: Function }) => {
        commands.push({ name, handler: opts.handler });
      },
    };
    const store = {
      loadIndex: async () => SAMPLE_SKILLS,
      getProjectName: () => "demo-project",
      move: async () => ({ success: true } as SkillResult),
      delete: async () => ({ success: true } as SkillResult),
    };

    registerSkillsCommand(pi as any, store as any);

    await commands[0].handler({}, {
      hasUI: true,
      ui: {
        custom: async (
          factory: Function,
          options: { overlay?: boolean },
        ) => {
          customInvoked = true;
          assert.strictEqual(options.overlay, true);
          // factory invocation is unnecessary for this contract-level test
          return undefined;
        },
        confirm: async () => true,
        notify: () => undefined,
      },
    });

    assert.strictEqual(customInvoked, true);
  });

  it("falls back to read-only notify output when custom modal throws", async () => {
    const commands: Array<{ name: string; handler: Function }> = [];
    const notifications: Array<{ message: string; severity: string }> = [];
    const pi = {
      registerCommand: (name: string, opts: { handler: Function }) => {
        commands.push({ name, handler: opts.handler });
      },
    };
    const store = {
      loadIndex: async () => SAMPLE_SKILLS,
      getProjectName: () => "demo-project",
      move: async () => ({ success: true } as SkillResult),
      delete: async () => ({ success: true } as SkillResult),
    };

    registerSkillsCommand(pi as any, store as any);

    await commands[0].handler({}, {
      hasUI: true,
      ui: {
        custom: async () => {
          throw new Error("UI backend unavailable");
        },
        confirm: async () => true,
        notify: (message: string, severity: string) => notifications.push({ message, severity }),
      },
    });

    assert.strictEqual(notifications.length, 2);
    assert.strictEqual(notifications[0].severity, "warning");
    assert.ok(notifications[0].message.includes("read-only list fallback"));
    assert.strictEqual(notifications[1].severity, "info");
    assert.ok(notifications[1].message.includes("Procedural Skills"));
  });
});
