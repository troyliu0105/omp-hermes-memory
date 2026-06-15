/**
 * In-process LLM review — replaces the `omp -p` subprocess approach.
 *
 * Uses `completeSimple` from `@oh-my-pi/pi-ai` for a single in-process LLM call.
 * No subprocess is spawned, so:
 *   - No orphaned processes after OMP exits (the HTTP request dies with the process).
 *   - No extension double-load / MemoryStore race (same process, same store objects).
 *   - Model config and API keys are resolved from the same registry the parent uses.
 *
 * The LLM is asked to output a JSON array of memory operations instead of calling
 * a `memory` tool. Each operation is applied directly to the store(s), eliminating
 * the multi-turn agent loop overhead.
 */

import type { Api, AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai/types";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { MemoryStore } from "../store/memory-store.js";
import type { MemoryCategory, MemoryConfig } from "../types.js";

type ChildLlmConfig = Pick<MemoryConfig, "llmModelOverride" | "llmThinkingOverride">;

/** The four targets the LLM can write to. */
type MemoryTarget = "memory" | "user" | "failure" | "project";

/** A single memory operation the LLM wants us to apply. */
interface MemoryOperation {
  action: "add" | "replace" | "remove";
  target: MemoryTarget;
  content?: string;
  match?: string;
  old_text?: string;
  category?: MemoryCategory;
  failure_reason?: string;
}

/** Result of running a review — text output from the LLM. */
export interface LlmReviewResult {
  text: string;
  error?: string;
}

/** Result of applying operations to the store(s). */
export interface ApplyResult {
  applied: number;
  skipped: number;
  errors: string[];
}

/**
 * Resolve which model to use for the LLM call.
 *
 * Priority:
 *   1. `config.llmModelOverride` — resolve from the registry by pattern.
 *   2. `ctx.model` — the current session model.
 *
 * Returns null if no model is available (e.g. running in print mode without a model).
 */
export function resolveReviewModel(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  config: ChildLlmConfig,
): Model<Api> | null {
  const override = config.llmModelOverride?.trim();
  if (override) {
    const available = ctx.modelRegistry.getAll();
    // Linear scan through all models, matching by id or provider/id.
    const lower = override.toLowerCase();
    for (const m of available) {
      const fullId = `${m.provider}/${m.id}`.toLowerCase();
      if (fullId === lower || m.id.toLowerCase() === lower) {
        return m;
      }
    }
    // Fallback: partial match on model id
    for (const m of available) {
      if (m.id.toLowerCase().includes(lower)) {
        return m;
      }
    }
  }
  return ctx.model ?? null;
}

/**
 * Resolve the Effort (thinking level) for the LLM call.
 *
 * When a model override is set but no explicit thinking override, we default to
 * "off" — background reviews don't need extended thinking and it wastes tokens.
 */
function resolveThinkingLevel(config: ChildLlmConfig): Effort | undefined {
  const override = config.llmModelOverride?.trim();
  const explicit = config.llmThinkingOverride;
  if (explicit === "off") return undefined;
  if (explicit) return explicit as Effort;
  if (override) return undefined; // default off when overriding model
  return undefined;
}

/**
 * Function signature for the core LLM call. Injectable for testing.
 * In production, this is `completeSimple` from `@oh-my-pi/pi-ai`.
 */
export type LlmCallFn = (
  model: Model<Api>,
  context: Context,
  options: {
    apiKey?: string;
    reasoning?: Effort;
    signal?: AbortSignal;
    maxTokens?: number;
  },
) => Promise<AssistantMessage>;

// Lazy-loaded singleton — avoids importing `@oh-my-pi/pi-ai/stream` at module
// load time, which would pull in the `bun` runtime dependency in test contexts
// (tsx). The real import only happens in production when the first review runs.
let _completeSimple: LlmCallFn | null = null;

async function getDefaultLlmCall(): Promise<LlmCallFn> {
  if (!_completeSimple) {
    const mod = await import("@oh-my-pi/pi-ai/stream");
    _completeSimple = mod.completeSimple as LlmCallFn;
  }
  return _completeSimple;
}

/**
 * Run a single in-process LLM call with `completeSimple`.
 *
 * This is the core replacement for `execChildPrompt`. Instead of spawning an
 * `omp -p` subprocess and having the LLM call a `memory` tool, we make one LLM
 * call that returns structured JSON operations which we apply directly.
 */
export async function runLlmReview(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  systemPrompt: string,
  userPrompt: string,
  config: ChildLlmConfig,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    llmCall?: LlmCallFn;
  } = {},
): Promise<LlmReviewResult> {
  const model = resolveReviewModel(ctx, config);
  if (!model) {
    return { text: "", error: "No model available for in-process review." };
  }

  let apiKey: string | undefined;
  try {
    apiKey = await ctx.modelRegistry.getApiKey(model);
  } catch {
    apiKey = undefined;
  }

  const thinking = resolveThinkingLevel(config);
  const context: Context = {
    systemPrompt: [systemPrompt],
    messages: [
      {
        role: "user",
        content: userPrompt,
 timestamp: Date.now(),
      },
    ],
  };

  try {
    const llmCall = options.llmCall ?? (await getDefaultLlmCall());
    const message = await llmCall(model, context, {
      apiKey,
      reasoning: thinking,
      signal: options.signal,
      maxTokens: 4096,
    });

    const text = message.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    return { text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { text: "", error: msg };
  }
}

/**
 * Extract a JSON array from LLM text output.
 *
 * The LLM may wrap the JSON in markdown fences, add prose before/after, or
 * include a bare `[]` when there's nothing to save. This function finds the
 * first `[` and its matching `]`, handling nested brackets.
 */
export function extractJsonArray(text: string): MemoryOperation[] {
  if (!text) return [];

  // Strip markdown code fences
  const cleaned = text.replace(/```(?:json)?\s*/gi, "").replace(/```\s*/g, "");

  // Find the JSON array boundaries
  const start = cleaned.indexOf("[");
  if (start === -1) return [];

  // Find matching close bracket, accounting for nesting and string literals
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        const jsonStr = cleaned.slice(start, i + 1);
        try {
          const parsed: unknown = JSON.parse(jsonStr);
          if (Array.isArray(parsed)) {
            return parsed.filter(isValidOperation);
          }
        } catch {
          return [];
        }
      }
    }
  }
  return [];
}

function isValidOperation(value: unknown): value is MemoryOperation {
  if (!value || typeof value !== "object") return false;
  const op = value as Record<string, unknown>;
  if (op.action !== "add" && op.action !== "replace" && op.action !== "remove") return false;
  if (
    op.target !== "memory" &&
    op.target !== "user" &&
    op.target !== "failure" &&
    op.target !== "project"
  ) {
    return false;
  }
  return true;
}

/**
 * Apply memory operations to the appropriate store(s).
 *
 * Each operation routes to either the global store or the project store based
 * on its `target`. Failure-target operations with a category are routed through
 * `addFailure` to include the metadata envelope.
 *
 * @returns count of applied and skipped operations, plus any error messages.
 */
export async function applyMemoryOperations(
  globalStore: MemoryStore,
  projectStore: MemoryStore | null,
  operations: MemoryOperation[],
  projectName?: string | null,
): Promise<ApplyResult> {
  let applied = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const op of operations) {
    try {
      const isProject = op.target === "project";
      const store = isProject ? projectStore : globalStore;
      if (!store) {
        skipped++;
        continue;
      }

      // Failure target uses addFailure() for metadata, other targets use add()
      const target = isProject ? "memory" : op.target as "memory" | "user" | "failure";

      switch (op.action) {
        case "add": {
          if (!op.content) {
            skipped++;
            continue;
          }
          if (target === "failure") {
            const result = await store.addFailure(op.content, {
              category: op.category ?? "failure",
              failureReason: op.failure_reason,
              project: isProject ? (projectName?.trim() || undefined) : undefined,
            });
            if (result.success) applied++;
            else { skipped++; errors.push(result.error ?? "add failed"); }
          } else {
            const result = await store.add(target, op.content);
            if (result.success) applied++;
            else { skipped++; errors.push(result.error ?? "add failed"); }
          }
          break;
        }
        case "replace": {
          const match = op.match ?? op.old_text;
          if (!match || !op.content) {
            skipped++;
            continue;
          }
          const result = await store.replace(target, match, op.content);
          if (result.success) applied++;
          else { skipped++; errors.push(result.error ?? "replace failed"); }
          break;
        }
        case "remove": {
          const match = op.match ?? op.old_text;
          if (!match) {
            skipped++;
            continue;
          }
          const result = await store.remove(target, match);
          if (result.success) applied++;
          else { skipped++; errors.push(result.error ?? "remove failed"); }
          break;
        }
      }
    } catch (err) {
      skipped++;
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { applied, skipped, errors };
}

/**
 * Full review-and-apply pipeline: call the LLM, parse JSON operations, apply
 * them to the store(s). Returns a summary suitable for user-facing notifications.
 *
 * If the LLM output contains no JSON array (e.g. "Nothing to save."), the
 * result is { applied: 0, nothingToSave: true }.
 */
export async function reviewAndApply(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  systemPrompt: string,
  userPrompt: string,
  globalStore: MemoryStore,
  projectStore: MemoryStore | null,
  config: ChildLlmConfig,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    projectName?: string | null;
    llmCall?: LlmCallFn;
  } = {},
): Promise<{ applied: number; skipped: number; nothingToSave: boolean; error?: string }> {
  const result = await runLlmReview(ctx, systemPrompt, userPrompt, config, options);

  if (result.error) {
    return { applied: 0, skipped: 0, nothingToSave: true, error: result.error };
  }

  const text = result.text.toLowerCase();
  if (!result.text || text.includes("nothing to save")) {
    return { applied: 0, skipped: 0, nothingToSave: true };
  }

  const operations = extractJsonArray(result.text);
  if (operations.length === 0) {
    return { applied: 0, skipped: 0, nothingToSave: true };
  }

  const applyResult = await applyMemoryOperations(
    globalStore,
    projectStore,
    operations,
    options.projectName,
  );

  return {
    applied: applyResult.applied,
    skipped: applyResult.skipped,
    nothingToSave: applyResult.applied === 0,
  };
}
