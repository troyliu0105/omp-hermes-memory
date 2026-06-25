/**
 * Memory tool — registers the LLM-callable `memory` tool.
 * Ported from hermes-agent/tools/memory_tool.py (MEMORY_SCHEMA + memory_tool dispatch).
 * See PLAN.md → "Hermes Source File Reference Map" for source lines.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { Type } from "typebox";
import { MemoryStore } from "../store/memory-store.js";
import { DatabaseManager } from "../store/db.js";
import {
  formatFailureMemoryContent,
  removeExactSyncedMemories,
  removeSyncedMemories,
  replaceSyncedMemories,
  syncMemoryEntry,
} from "../store/sqlite-memory-store.js";
import { MEMORY_TOOL_DESCRIPTION } from "../constants.js";
import { checkScopeViolation, scopeViolationMessage } from "../store/scope-guard.js";
import type { MemoryCategory, MemoryResult } from "../types.js";

function appendSyncWarning(result: MemoryResult, warning: string): MemoryResult {
  const warnings = [...(((result as any).warnings ?? []) as string[]), warning];
  const message = result.message ? `${result.message} Warning: ${warning}` : warning;
  return {
    ...result,
    message,
    warning,
    warnings,
  } as MemoryResult;
}

function formatMemoryToolText(result: MemoryResult): string {
  const evictedEntries = result.evicted_entries ?? [];
  if (result.success && evictedEntries.length > 0) {
    const lines = [
      result.message ?? `Memory updated. Rotated ${evictedEntries.length} older ${evictedEntries.length === 1 ? "entry" : "entries"} to stay within the limit.`,
      "",
      "Rotated active memory entries:",
      "",
    ];

    evictedEntries.forEach((entry, index) => {
      lines.push(`${index + 1}. ${entry}`);
      lines.push("");
    });

    lines.push("If one of these entries should stay active, add it again.");
    if (result.usage) lines.push(`Usage: ${result.usage}`);
    return lines.join("\n").trim();
  }

  return JSON.stringify(result);
}

function sqliteProjectFor(rawTarget: "memory" | "user" | "project" | "failure", projectName?: string | null): string | null | undefined {
  if (rawTarget === "project") return projectName?.trim() || null;
  if (rawTarget === "memory") return null;
  if (rawTarget === "user") return null;
  if (rawTarget === "failure") return null;
  return undefined;
}

function sqliteTargetFor(rawTarget: "memory" | "user" | "project" | "failure"): "memory" | "user" | "failure" {
  if (rawTarget === "project") return "memory";
  return rawTarget;
}

async function syncAddToSqlite(
  rawTarget: "memory" | "user" | "project" | "failure",
  content: string,
  category: MemoryCategory | undefined,
  failureReason: string | undefined,
  dbManager: DatabaseManager | null,
  projectName?: string | null,
): Promise<string | null> {
  if (!dbManager) return null;

  try {
    const sqliteTarget = sqliteTargetFor(rawTarget);
    const sqliteProject = sqliteProjectFor(rawTarget, projectName);

    if (rawTarget === "failure") {
      const failureCategory = category ?? "failure";
      syncMemoryEntry(dbManager, {
        content: formatFailureMemoryContent(content, {
          category: failureCategory,
          failureReason,
        }),
        target: "failure",
        project: sqliteProject ?? null,
        category: failureCategory,
        failureReason,
      });
      return null;
    }

    syncMemoryEntry(dbManager, {
      content,
      target: sqliteTarget,
      project: sqliteProject ?? null,
    });
    return null;
  } catch (err) {
    return `Saved to Markdown, but SQLite search sync failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function syncReplaceToSqlite(
  rawTarget: "memory" | "user" | "project" | "failure",
  oldText: string,
  newContent: string,
  dbManager: DatabaseManager | null,
  projectName?: string | null,
): Promise<string | null> {
  if (!dbManager) return null;

  try {
    const sqliteTarget = sqliteTargetFor(rawTarget);
    const sqliteProject = sqliteProjectFor(rawTarget, projectName);
    const syncResult = replaceSyncedMemories(dbManager, oldText, {
      content: newContent,
      target: sqliteTarget,
      project: sqliteProject,
    });

    if (syncResult.matched === 0) {
      return "Saved to Markdown, but no matching SQLite memory row was updated. Run /memory-sync-markdown if search results look stale.";
    }

    return null;
  } catch (err) {
    return `Saved to Markdown, but SQLite search sync failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function syncRemoveFromSqlite(
  rawTarget: "memory" | "user" | "project" | "failure",
  oldText: string,
  dbManager: DatabaseManager | null,
  projectName?: string | null,
): Promise<string | null> {
  if (!dbManager) return null;

  try {
    const sqliteTarget = sqliteTargetFor(rawTarget);
    const sqliteProject = sqliteProjectFor(rawTarget, projectName);
    const syncResult = removeSyncedMemories(dbManager, oldText, {
      target: sqliteTarget,
      project: sqliteProject,
    });

    if (syncResult.matched === 0) {
      return "Saved to Markdown, but no matching SQLite memory row was removed. Run /memory-sync-markdown if search results look stale.";
    }

    return null;
  } catch (err) {
    return `Saved to Markdown, but SQLite search sync failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function syncEvictionsFromSqlite(
  rawTarget: "memory" | "user" | "project" | "failure",
  evictedEntries: string[] | undefined,
  dbManager: DatabaseManager | null,
  projectName?: string | null,
): Promise<void> {
  if (!dbManager) return;
  if (!evictedEntries || evictedEntries.length === 0) return;

  const sqliteTarget = sqliteTargetFor(rawTarget);
  const sqliteProject = sqliteProjectFor(rawTarget, projectName);

  for (const entry of evictedEntries) {
    try {
      removeExactSyncedMemories(dbManager, entry, {
        target: sqliteTarget,
        project: sqliteProject,
      });
    } catch {
      // FIFO already updated the Markdown source of truth. SQLite is only a
      // best-effort search mirror, so eviction cleanup must not fail the write.
    }
  }
}

export function registerMemoryTool(
  pi: ExtensionAPI,
  store: MemoryStore,
  projectStore: MemoryStore | null,
  dbManager: DatabaseManager | null = null,
  projectName?: string | null,
): void {
  pi.registerTool({
    name: "memory",
    label: "Memory",
    description: MEMORY_TOOL_DESCRIPTION,
    parameters: Type.Object({
      action: Type.Union([Type.Literal("add"), Type.Literal("replace"), Type.Literal("remove")]),
      target: Type.Union([Type.Literal("memory"), Type.Literal("user"), Type.Literal("project"), Type.Literal("failure")]),
      content: Type.Optional(
        Type.String({ description: "Entry content for add/replace" })
      ),
      match: Type.Optional(
        Type.String({ description: "Substring to match for replace/remove" })
      ),
      old_text: Type.Optional(
        Type.String({ description: "Legacy alias for match" })
      ),
      category: Type.Optional(
        Type.Union([Type.Literal("failure"), Type.Literal("correction"), Type.Literal("insight"), Type.Literal("preference"), Type.Literal("convention"), Type.Literal("tool-quirk")], {
          description: "Category for failure memories",
        })
      ),
      failure_reason: Type.Optional(Type.String({ description: "Optional reason this failure happened" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { action, target: rawTarget, content, old_text, category, failure_reason } = params;

      // Route 'project' to projectStore using the normal MEMORY.md target.
      const target = rawTarget === "project" ? "memory" : rawTarget as "memory" | "user" | "failure";
      const activeStore = rawTarget === "project" ? projectStore : store;

      if (rawTarget === "project" && !projectStore) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: "Project memory is not available (no project detected)." }) }],
          details: {},
        };
      }

      // After the guard above, activeStore is guaranteed non-null when rawTarget === 'project'
      const store_ = activeStore!;
      // Multi-device freshness: pull the latest version of the target scope before
      // acting, so this device operates on current remote state. Best-effort: a
      // network failure here does not block the operation — the optimistic-lock
      // conflict retry inside MemoryStore.add/replace/remove still catches races.
      try {
        await store_.refreshTargets([target]);
      } catch {
        // Ignore — proceed with in-session state; conflict detection handles races.
      }

      let result: MemoryResult;
      let syncWarning: string | null = null;
      switch (action) {
        case "add":
          if (!content) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: false,
                    error: "Content is required for 'add' action.",
                  }),
                },
              ],
              details: {},
            };
          }
          // Scope enforcement: global USER.md / MEMORY.md must not receive
          // project-specific content. 'project' and 'failure' targets are exempt
          // (project is the intended destination; failure is global by design
          // and the prompt instructs stripping project details there).
          if (rawTarget === "user" || rawTarget === "memory") {
            const scopeCheck = checkScopeViolation(content);
            if (scopeCheck.violated) {
              result = {
                success: false,
                error: scopeViolationMessage(rawTarget, scopeCheck.detectedSignals),
              };
              break;
            }
          }
          // Handle failure target with category
          if (rawTarget === "failure") {
            const memoryCategory = (category || "failure") as MemoryCategory;
            result = await store_.addFailure(content, {
              category: memoryCategory,
              failureReason: failure_reason,
            });
            if (result.success) {
              syncWarning = await syncAddToSqlite(rawTarget, content, memoryCategory, failure_reason, dbManager, projectName);
            }
          } else {
            result = await store_.add(target, content);
            if (result.success) {
              await syncEvictionsFromSqlite(rawTarget, result.evicted_entries, dbManager, projectName);
              syncWarning = await syncAddToSqlite(rawTarget, content, undefined, undefined, dbManager, projectName);
            }
          }
          break;

        case "replace":
          if (!old_text) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: false,
                    error: "old_text is required for 'replace' action.",
                  }),
                },
              ],
              details: {},
            };
          }
          if (!content) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: false,
                    error: "content is required for 'replace' action.",
                  }),
                },
              ],
              details: {},
            };
          }
          // Scope enforcement (same as add): prevent replacing a global entry
          // with project-specific content.
          if (rawTarget === "user" || rawTarget === "memory") {
            const scopeCheck = checkScopeViolation(content);
            if (scopeCheck.violated) {
              result = {
                success: false,
                error: scopeViolationMessage(rawTarget, scopeCheck.detectedSignals),
              };
              break;
            }
          }
          result = await store_.replace(target, old_text, content);
          if (result.success) {
            syncWarning = await syncReplaceToSqlite(rawTarget, old_text, content, dbManager, projectName);
          }
          break;

        case "remove":
          if (!old_text) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: false,
                    error: "old_text is required for 'remove' action.",
                  }),
                },
              ],
              details: {},
            };
          }
          result = await store_.remove(target, old_text);
          if (result.success) {
            syncWarning = await syncRemoveFromSqlite(rawTarget, old_text, dbManager, projectName);
          }
          break;

        default:
          result = {
            success: false,
            error: `Unknown action '${action}'. Use: add, replace, remove`,
          };
      }

      if (syncWarning && result.success) {
        result = appendSyncWarning(result, syncWarning);
      }

      // Tag project results so the caller knows the scope
      if (rawTarget === "project" && result.success) {
        result = {
          ...result,
          target: "project",
        };
      }

      return {
        content: [{ type: "text", text: formatMemoryToolText(result) }],
        details: result,
      };
    },
  });
}
