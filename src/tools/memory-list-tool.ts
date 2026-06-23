/**
 * Memory list tool — registers the LLM-callable `memory_list` tool.
 *
 * Unlike `memory_search` (SQLite-backed, query-oriented), this tool returns the
 * current live Markdown-backed memory entries exactly, read from the in-session
 * `MemoryStore` getters. It does not touch the frozen system-prompt snapshot and
 * does not call `loadFromDisk()`, so it reflects in-memory mutations made
 * during the current session.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { Type } from "typebox";
import { MemoryStore } from "../store/memory-store.js";

export const MEMORY_LIST_TOOL_NAME = "memory_list";

type ListTarget = "memory" | "user" | "project" | "failure";

interface MemoryListBlock {
  target: ListTarget;
  entry_count: number;
  entries: string[];
}

interface MemoryListResult {
  success: true;
  target: "all" | ListTarget;
  total_count: number;
  project_available: boolean;
  project_name?: string;
  targets: MemoryListBlock[];
  message?: string;
}

interface MemoryListError {
  success: false;
  target: "all" | ListTarget;
  total_count: number;
  project_available: boolean;
  targets: MemoryListBlock[];
  error: string;
}


export function registerMemoryListTool(
  pi: ExtensionAPI,
  store: MemoryStore,
  projectStore: MemoryStore | null,
  projectName?: string | null,
): void {
  pi.registerTool({
    name: MEMORY_LIST_TOOL_NAME,
    label: "Memory List",
    description:
      "List all current Markdown-backed persistent memory entries from the live in-session stores. Use this for exact inspection; use memory_search for keyword lookup across the SQLite mirror.",
    parameters: Type.Object(
      {
        target: Type.Optional(
          Type.Union(
            [
              Type.Literal("all"),
              Type.Literal("memory"),
              Type.Literal("user"),
              Type.Literal("project"),
              Type.Literal("failure"),
            ],
            {
              description:
                "Filter target. Omit or use 'all' to list every current memory target.",
            },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params) {
      const requestedTarget = params.target ?? "all";
      const trimmedProjectName = projectName?.trim() || undefined;
      const projectAvailable = projectStore !== null;

      // Project target requires an active detected project.
      if (requestedTarget === "project" && !projectStore) {
        const errorResult: MemoryListError = {
          success: false,
          target: "project",
          total_count: 0,
          project_available: false,
          targets: [],
          error: "Project memory is not available (no project detected).",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(errorResult) }],
          details: errorResult,
        };
      }

      // Gather blocks for the requested target(s).
      const blocks: MemoryListBlock[] = [];

      if (requestedTarget === "all" || requestedTarget === "memory") {
        const entries = store.getMemoryEntries();
        blocks.push({ target: "memory", entry_count: entries.length, entries });
      }
      if (requestedTarget === "all" || requestedTarget === "user") {
        const entries = store.getUserEntries();
        blocks.push({ target: "user", entry_count: entries.length, entries });
      }
      if (projectStore && (requestedTarget === "all" || requestedTarget === "project")) {
        const entries = projectStore.getMemoryEntries();
        blocks.push({ target: "project", entry_count: entries.length, entries });
      }
      if (requestedTarget === "all" || requestedTarget === "failure") {
        const entries = store.getAllFailureEntries();
        blocks.push({ target: "failure", entry_count: entries.length, entries });
      }

      const totalCount = blocks.reduce((sum, b) => sum + b.entry_count, 0);
      const empty = totalCount === 0;

      const result: MemoryListResult = {
        success: true,
        target: requestedTarget,
        total_count: totalCount,
        project_available: projectAvailable,
        targets: blocks,
      };

      if (trimmedProjectName) {
        result.project_name = trimmedProjectName;
      }

      if (empty) {
        result.message =
          requestedTarget === "all"
            ? "No current memory entries found."
            : `No current memory entries found for target '${requestedTarget}'.`;
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  });
}
