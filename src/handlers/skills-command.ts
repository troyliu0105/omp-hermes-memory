/**
 * Skills command — /memory-skills lists all agent-created skills.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SkillStore } from "../store/skill-store.js";

export function registerSkillsCommand(pi: ExtensionAPI, store: SkillStore): void {
  pi.registerCommand("memory-skills", {
    description: "List all agent-created skills (procedural memory)",
    handler: async (_args, ctx) => {
      const skills = await store.loadIndex();
      const globalSkills = skills.filter((skill) => skill.scope === "global");
      const projectSkills = skills.filter((skill) => skill.scope === "project");
      const projectName = store.getProjectName();

      const lines: string[] = [];
      lines.push("");
      lines.push("  ╔══════════════════════════════════════════════╗");
      lines.push("  ║            🧠 Procedural Skills             ║");
      lines.push("  ╚══════════════════════════════════════════════╝");
      lines.push("");

      if (skills.length === 0) {
        lines.push("  (no skills created yet)");
        lines.push("");
        lines.push("  Skills are auto-created after complex tasks,");
        lines.push("  or you can ask the agent to create one.");
      } else {
        if (globalSkills.length > 0) {
          lines.push("  Global Skills");
          lines.push("  ─────────────");
          for (const skill of globalSkills) {
            lines.push(`  📄 ${skill.displayName || skill.name}`);
            lines.push(`     ${skill.description}`);
            lines.push(`     id: ${skill.skillId}`);
            lines.push(`     path: ${skill.path}`);
            lines.push("");
          }
        }

        if (projectSkills.length > 0) {
          lines.push(`  Project Skills${projectName ? ` (${projectName})` : ""}`);
          lines.push("  ──────────────");
          for (const skill of projectSkills) {
            lines.push(`  📄 ${skill.displayName || skill.name}`);
            lines.push(`     ${skill.description}`);
            lines.push(`     id: ${skill.skillId}`);
            lines.push(`     path: ${skill.path}`);
            lines.push("");
          }
        }
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
