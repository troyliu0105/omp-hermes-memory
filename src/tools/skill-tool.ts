/**
 * Skill tool — registers the LLM-callable `skill` tool for procedural memory.
 * Complements the `memory` tool (declarative knowledge) with procedural knowledge.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { SkillStore } from "../store/skill-store.js";
import { SKILL_TOOL_DESCRIPTION } from "../constants.js";

function normalizeTextList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatOrderedList(items: string[]): string {
  return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

function formatBulletList(items: string[], fallback: string): string {
  if (items.length === 0) return `- ${fallback}`;
  return items.map((item) => `- ${item}`).join("\n");
}

function buildStructuredSkillBody(
  whenToUse: string,
  procedureSteps: string[],
  pitfalls: string[],
  verificationSteps: string[],
): string {
  return [
    "## When to Use",
    whenToUse,
    "",
    "## Procedure",
    formatOrderedList(procedureSteps),
    "",
    "## Pitfalls",
    formatBulletList(pitfalls, "No notable pitfalls recorded yet."),
    "",
    "## Verification",
    formatOrderedList(verificationSteps),
  ].join("\n");
}

const SKILL_ID_PARAM = Type.String({
  description: "Stable skill id for view/patch/update/delete. e.g., 'global:debug-typescript-errors' or 'project:my-repo:release-app'. Legacy alias 'edit' also accepts this field.",
});

const STRUCTURED_SKILL_FIELDS = {
  when_to_use: Type.String({
    description: "Short explanation of when this skill should be used and where its boundaries are.",
  }),
  procedure_steps: Type.Array(Type.String(), {
    description: "Ordered concrete steps for the workflow.",
  }),
  pitfalls: Type.Optional(Type.Array(Type.String(), {
    description: "Optional common mistakes, caveats, or failure modes to avoid.",
  })),
  verification_steps: Type.Array(Type.String(), {
    description: "Concrete checks that confirm the workflow succeeded.",
  }),
} as const;

const OPTIONAL_STRUCTURED_SKILL_FIELDS = {
  when_to_use: Type.Optional(Type.String({
    description: "Short explanation of when this skill should be used and where its boundaries are.",
  })),
  procedure_steps: Type.Optional(Type.Array(Type.String(), {
    description: "Ordered concrete steps for the workflow.",
  })),
  pitfalls: Type.Optional(Type.Array(Type.String(), {
    description: "Optional common mistakes, caveats, or failure modes to avoid.",
  })),
  verification_steps: Type.Optional(Type.Array(Type.String(), {
    description: "Concrete checks that confirm the workflow succeeded.",
  })),
} as const;

const SKILL_TOOL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: StringEnum(["create", "view", "patch", "update", "edit", "delete"] as const, {
      description: "The skill action to perform.",
    }),
    name: Type.String({ description: "Skill name. e.g., 'debug-typescript-errors'" }),
    skill_id: SKILL_ID_PARAM,
    description: Type.String({ description: "One-line description of when to use this skill." }),
    scope: StringEnum(["global", "project"] as const, {
      description: "Use 'global' for portable procedures and 'project' for repo-specific workflows.",
    }),
    section: Type.String({ description: "Section header to patch. e.g., 'Procedure', 'Pitfalls'" }),
    content: Type.String({
      description: "Raw markdown body for create/update, or new section content for patch.",
    }),
    when_to_use: STRUCTURED_SKILL_FIELDS.when_to_use,
    procedure_steps: STRUCTURED_SKILL_FIELDS.procedure_steps,
    pitfalls: Type.Array(Type.String(), {
      description: "Optional common mistakes, caveats, or failure modes to avoid.",
    }),
    verification_steps: STRUCTURED_SKILL_FIELDS.verification_steps,
  },
  required: ["action"],
  allOf: [
    {
      if: {
        properties: { action: { const: "create" } },
        required: ["action"],
      },
      then: {
        required: ["name", "description", "scope"],
        anyOf: [
          { required: ["content"] },
          { required: ["when_to_use", "procedure_steps", "verification_steps"] },
        ],
      },
    },
    {
      if: {
        properties: { action: { const: "patch" } },
        required: ["action"],
      },
      then: {
        required: ["skill_id", "section", "content"],
      },
    },
    {
      if: {
        properties: { action: { enum: ["update", "edit"] } },
        required: ["action"],
      },
      then: {
        required: ["skill_id"],
        anyOf: [
          { required: ["description"] },
          { required: ["content"] },
          { required: ["when_to_use", "procedure_steps", "verification_steps"] },
        ],
      },
    },
    {
      if: {
        properties: { action: { const: "delete" } },
        required: ["action"],
      },
      then: {
        required: ["skill_id"],
      },
    },
  ],
} as const;

export function registerSkillTool(pi: ExtensionAPI, store: SkillStore): void {
  pi.registerTool({
    name: "skill",
    label: "Skill",
    description: SKILL_TOOL_DESCRIPTION,
    promptSnippet: "Save or manage reusable procedures and patterns",
    promptGuidelines: [
      "Use the skill tool after completing complex tasks that required trial and error or multiple tool calls.",
      "Use 'create' to save a new reusable procedure, 'patch' to update a section of an existing skill by skill_id, and 'update' for a full rewrite.",
      "Scope is required on create: choose scope='global' for transferable procedures and scope='project' when the workflow depends on this repo's paths, scripts, conventions, or deploy steps.",
      "Prefer structured fields for create/update: when_to_use, procedure_steps, pitfalls, and verification_steps. The tool will render valid SKILL.md sections for you.",
      "Use 'view' before patching or updating when you need to inspect an existing skill.",
      "Do NOT use skills for temporary task state — only for durable, reusable procedures.",
    ],
    parameters: SKILL_TOOL_PARAMETERS,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const skillParams = params as {
        action: "create" | "view" | "patch" | "update" | "edit" | "delete";
        name?: string;
        skill_id?: string;
        description?: string;
        scope?: "global" | "project";
        section?: string;
        content?: string;
        when_to_use?: string;
        procedure_steps?: unknown;
        pitfalls?: unknown;
        verification_steps?: unknown;
      };
      const {
        action,
        name,
        skill_id,
        description,
        scope,
        section,
        content,
        when_to_use,
        procedure_steps,
        pitfalls,
        verification_steps,
      } = skillParams;

      const whenToUse = typeof when_to_use === "string" ? when_to_use.trim() : "";
      const procedureSteps = normalizeTextList(procedure_steps);
      const pitfallItems = normalizeTextList(pitfalls);
      const verificationSteps = normalizeTextList(verification_steps);
      const hasStructuredBody = Boolean(whenToUse) || procedureSteps.length > 0 || pitfallItems.length > 0 || verificationSteps.length > 0;

      const buildBodyOrError = () => {
        if (content?.trim()) return { body: content.trim() };
        if (!hasStructuredBody) {
          return {
            error: "Either content or structured fields are required. Prefer when_to_use, procedure_steps, pitfalls, and verification_steps for create/update.",
          };
        }
        if (!whenToUse) {
          return { error: "when_to_use is required when content is omitted." };
        }
        if (procedureSteps.length === 0) {
          return { error: "procedure_steps is required when content is omitted." };
        }
        if (verificationSteps.length === 0) {
          return { error: "verification_steps is required when content is omitted." };
        }
        return {
          body: buildStructuredSkillBody(whenToUse, procedureSteps, pitfallItems, verificationSteps),
        };
      };

      let result;
      switch (action) {
        case "create":
          if (!name) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: "name is required for 'create' action." }) }],
              details: {},
            };
          }
          if (!description) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: "description is required for 'create' action." }) }],
              details: {},
            };
          }
          const createBodyResult = buildBodyOrError();
          if (!createBodyResult.body) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: createBodyResult.error }) }],
              details: {},
            };
          }
          if (!scope) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: "scope is required for 'create' action. Use 'global' or 'project'." }) }],
              details: {},
            };
          }
          result = await store.create(name, description, createBodyResult.body, scope);
          break;

        case "view":
          if (!skill_id) {
            const index = await store.loadIndex();
            return {
              content: [{ type: "text", text: JSON.stringify({ success: true, skills: index }) }],
              details: { skills: index },
            };
          }
          const doc = await store.loadSkill(skill_id);
          if (!doc) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: `Skill '${skill_id}' not found.` }) }],
              details: {},
            };
          }
          result = { success: true, ...doc };
          break;

        case "patch":
          if (!skill_id) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: "skill_id is required for 'patch' action." }) }],
              details: {},
            };
          }
          if (!section) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: "section is required for 'patch' action." }) }],
              details: {},
            };
          }
          if (!content) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: "content is required for 'patch' action." }) }],
              details: {},
            };
          }
          result = await store.patch(skill_id, section, content);
          break;

        case "update":
        case "edit": {
          const updateActionLabel = action === "edit" ? "edit" : "update";
          if (!skill_id) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: `skill_id is required for '${updateActionLabel}' action.` }) }],
              details: {},
            };
          }
          const updateBodyResult = buildBodyOrError();
          const nextDescription = description?.trim() || "";
          const nextBody = updateBodyResult.body ?? content?.trim() ?? "";
          if (!nextDescription && !nextBody) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: `Provide description, content, or structured fields for '${updateActionLabel}'.` }) }],
              details: {},
            };
          }
          if (hasStructuredBody && !updateBodyResult.body) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: updateBodyResult.error }) }],
              details: {},
            };
          }
          result = await store.edit(skill_id, nextDescription, nextBody);
          break;
        }

        case "delete":
          if (!skill_id) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: "skill_id is required for 'delete' action." }) }],
              details: {},
            };
          }
          result = await store.delete(skill_id);
          break;

        default:
          result = {
            success: false,
            error: `Unknown action '${action}'. Use: create, view, patch, update, delete`,
          };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  });
}
