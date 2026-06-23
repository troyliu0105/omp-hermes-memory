/**
 * Auto-consolidation — when memory hits capacity, trigger automatic
 * consolidation instead of returning an error.
 *
 * Uses in-process `completeSimple` — no subprocess. The consolidator needs
 * access to `ctx.modelRegistry` / `ctx.model` to resolve the model and API key,
 * which is provided via a `ReviewContextProvider` callback since the consolidator
 * is wired at startup but runs during event handlers.
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { MemoryStore } from "../store/memory-store.js";
import { REVIEW_SYSTEM_PROMPT, CONSOLIDATION_USER_PROMPT, ENTRY_DELIMITER } from "../constants.js";
import type { ConsolidationResult, MemoryConfig } from "../types.js";
import { runLlmReview, extractJsonArray, applyMemoryOperations } from "./llm-review.js";
import { MemoryUpdateGate } from "./memory-update-gate.js";

type MemoryTarget = "memory" | "user" | "failure";
type ToolMemoryTarget = MemoryTarget | "project";

/** Provides the current ExtensionContext for in-process LLM calls. */
export type ReviewContextProvider = () => Pick<ExtensionContext, "model" | "modelRegistry"> | null;

function entriesForTarget(store: MemoryStore, target: MemoryTarget): string[] {
  if (target === "user") return store.getUserEntries();
  if (target === "failure") return store.getAllFailureEntries();
  return store.getMemoryEntries();
}

function labelForTarget(target: MemoryTarget, toolTarget: ToolMemoryTarget): string {
  if (toolTarget === "project") return "Project Memory";
  if (target === "user") return "User Profile";
  if (target === "failure") return "Failure Memory";
  return "Memory";
}

export async function triggerConsolidation(
  ctxProvider: ReviewContextProvider,
  store: MemoryStore,
  target: MemoryTarget,
  updateGate: MemoryUpdateGate,
  signal?: AbortSignal,
  timeoutMs: number = 60000,
  toolTarget: ToolMemoryTarget = target,
  llmConfig: Pick<MemoryConfig, "llmModelOverride" | "llmThinkingOverride"> = {},
  llmCall?: import("./llm-review.js").LlmCallFn,
  projectStore: MemoryStore | null = null,
  projectName?: string | null,
): Promise<ConsolidationResult> {
  const ctx = ctxProvider();
  if (!ctx) {
    return { consolidated: false, error: "No context available for consolidation." };
  }

  return updateGate.runExclusive(async () => {
    const entries = entriesForTarget(store, target);
    const currentContent = entries.join(ENTRY_DELIMITER);

    const userPrompt = [
      CONSOLIDATION_USER_PROMPT,
      "",
      `--- Current ${labelForTarget(target, toolTarget)} Entries ---`,
      currentContent || "(empty)",
    ].join("\n");

    try {
      const result = await runLlmReview(ctx, REVIEW_SYSTEM_PROMPT, userPrompt, llmConfig, {
        signal,
        timeoutMs,
        llmCall,
      });

      if (result.error) {
        return { consolidated: false, error: result.error };
      }

      const operations = extractJsonArray(result.text);
      if (operations.length === 0) {
        return { consolidated: false, error: "LLM returned no consolidation operations." };
      }

      const scopedProjectStore = toolTarget === "project" ? (projectStore ?? store) : null;
      const scopedProjectName = toolTarget === "project" ? projectName : undefined;
      const applyResult = await applyMemoryOperations(store, scopedProjectStore, operations, scopedProjectName);

      if (applyResult.applied === 0) {
        return {
          consolidated: false,
          error: applyResult.errors[0] ?? "No operations could be applied.",
        };
      }

      return { consolidated: true };
    } catch (err) {
      return {
        consolidated: false,
        error: `Consolidation failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
      };
    }
  });
}

/**
 * Register the /memory-consolidate command for manual consolidation.
 */
export function registerConsolidateCommand(
  pi: ExtensionAPI,
  store: MemoryStore,
  timeoutMs: number = 60000,
  projectStore: MemoryStore | null = null,
  projectName?: string | null,
  llmConfig: Pick<MemoryConfig, "llmModelOverride" | "llmThinkingOverride"> = {},
  ctxProvider: ReviewContextProvider = () => null,
  updateGate: MemoryUpdateGate = new MemoryUpdateGate(),
): void {
  pi.registerCommand("memory-consolidate", {
    description: "Manually trigger memory consolidation to free up space",
    handler: async (_args, cmdCtx) => {
      const manualTimeoutMs = Math.max(timeoutMs, 180000);
      const results: string[] = [];
      const targets: Array<{
        label: string;
        store: MemoryStore;
        target: MemoryTarget;
        toolTarget: ToolMemoryTarget;
      }> = [
        { label: "memory", store, target: "memory", toolTarget: "memory" },
        { label: "user", store, target: "user", toolTarget: "user" },
        { label: "failure", store, target: "failure", toolTarget: "failure" },
      ];

      if (projectStore) {
        targets.push({
          label: projectName ? `project:${projectName}` : "project",
          store: projectStore,
          target: "memory",
          toolTarget: "project",
        });
      }

      try {
        cmdCtx.ui.notify(
          `🔄 Starting memory consolidation for ${targets.length} target${targets.length === 1 ? "" : "s"}...`,
          "info",
        );
      } catch {
        // Best-effort only. If the command context is already stale, continue
        // with the consolidation work rather than failing before it starts.
      }

      // Provide the command ctx for LLM calls during this manual consolidation
      const localCtxProvider: ReviewContextProvider = () => cmdCtx;

      for (const item of targets) {
        const entries = entriesForTarget(item.store, item.target);

        if (entries.length === 0) {
          results.push(`${item.label}: (empty, nothing to consolidate)`);
          continue;
        }

        try {
          cmdCtx.ui.notify(`⏳ Consolidating ${item.label}...`, "info");
        } catch {
          // Best-effort progress feedback only.
        }

        const result = await triggerConsolidation(
          localCtxProvider,
          item.store,
          item.target,
          updateGate,
          undefined,
          manualTimeoutMs,
          item.toolTarget,
          llmConfig,
          undefined,
          item.toolTarget === "project" ? item.store : null,
          item.toolTarget === "project" ? projectName : undefined,
        );

        if (result.consolidated) {
          await item.store.loadFromDisk();
          results.push(`${item.label}: ✅ consolidated`);
        } else {
          results.push(`${item.label}: ❌ ${result.error}`);
        }
      }

      const summary = `\n  🔄 Memory Consolidation\n  ${"─".repeat(30)}\n${results.map((r) => `  ${r}`).join("\n")}`;

      try {
        cmdCtx.ui.notify(summary, "info");
      } catch {
        // Child consolidation can indirectly trigger a runtime reload/session
        // replacement. If that happens, the original command ctx is stale by
        // the time we reach the final summary, so the command should exit
        // quietly instead of surfacing a stale-ctx error.
      }
    },
  });
}
