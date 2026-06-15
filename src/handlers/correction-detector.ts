/**
 * Correction detection — detects user corrections in real-time and triggers
 * an immediate memory save instead of waiting for the next nudge interval.
 *
 * Uses a two-pass filter:
 * - Strong patterns: always trigger (high confidence)
 * - Weak patterns: only trigger if followed by a directive clause
 * - Negative patterns: suppress even if a positive pattern matched
 *
 * Uses in-process `completeSimple` — no subprocess.
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { MemoryStore } from "../store/memory-store.js";
import { DatabaseManager } from "../store/db.js";
import {
  formatFailureMemoryContent,
  syncMemoryEntry,
} from "../store/sqlite-memory-store.js";
import {
  REVIEW_SYSTEM_PROMPT,
  REVIEW_USER_PROMPT,
  CORRECTION_STRONG_PATTERNS,
  CORRECTION_WEAK_PATTERNS,
  CORRECTION_NEGATIVE_PATTERNS,
  CORRECTION_DIRECTIVE_WORDS,
  ENTRY_DELIMITER,
} from "../constants.js";
import type { MemoryConfig } from "../types.js";
import { getMessageText } from "../types.js";
import { reviewAndApply } from "./llm-review.js";
import { MemoryUpdateGate } from "./memory-update-gate.js";

/**
 * Extract the directive part from a correction message.
 * E.g., "no, use pnpm instead" -> "use pnpm instead"
 */
function extractCorrectionDirective(text: string): string {
  return text.replace(/^(?:no|wrong|actually|stop|don'?t|please don'?t|that'?s not what I|i said|i told you|we already discussed)[,\.\s!]*/i, "").trim();
}

function compileCorrectionPatterns(
  configured: string[] | undefined,
  defaults: RegExp[],
): RegExp[] {
  if (!configured) return defaults;
  return configured.map((s) => {
    try { return new RegExp(s, "i"); } catch { return null; }
  }).filter((r): r is RegExp => r !== null);
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasDirectiveWord(remainder: string, words: string[]): boolean {
  const firstWord = remainder.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z']/g, "");
  if (!firstWord) return false;
  return words.includes(firstWord);
}

/**
 * Check if a user message is a correction using the two-pass filter.
 * Returns true if the message should trigger an immediate save.
 */
type CorrectionPatternConfig = Pick<MemoryConfig,
  "correctionStrongPatterns" |
  "correctionWeakPatterns" |
  "correctionNegativePatterns" |
  "correctionDirectiveWords"
>;

export function isCorrection(text: string, config?: CorrectionPatternConfig): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const strong = compileCorrectionPatterns(config?.correctionStrongPatterns, CORRECTION_STRONG_PATTERNS);
  const weak = compileCorrectionPatterns(config?.correctionWeakPatterns, CORRECTION_WEAK_PATTERNS);
  const negative = compileCorrectionPatterns(config?.correctionNegativePatterns, CORRECTION_NEGATIVE_PATTERNS);
  const directiveWords = config?.correctionDirectiveWords ?? CORRECTION_DIRECTIVE_WORDS;

  // Negative patterns suppress everything
  if (negative.some((re) => re.test(trimmed))) return false;

  // Strong patterns always trigger
  if (strong.some((re) => re.test(trimmed))) return true;

  // Weak patterns trigger only if followed by a directive
  for (const re of weak) {
    const match = trimmed.match(re);
    if (match && match[0]) {
      const remainder = trimmed.slice(match[0].length).trim();
      if (remainder && hasDirectiveWord(remainder, directiveWords)) return true;
    }
  }

  return false;
}

/** Minimal context slice the correction detector needs. */
interface CorrectionContext {
  sessionManager: { getBranch(): unknown[] };
  ui: ExtensionContext["ui"];
  model: ExtensionContext["model"];
  modelRegistry: ExtensionContext["modelRegistry"];
}

export function setupCorrectionDetector(
  pi: ExtensionAPI,
  store: MemoryStore,
  projectStore: MemoryStore | null,
  config: MemoryConfig,
  updateGate: MemoryUpdateGate,
  dbManager: DatabaseManager | null = null,
  projectName?: string | null,
): void {
  if (!config.correctionDetection) return;

  let pendingCorrection = false;
  let turnsSinceLastCorrection = 3; // Start at threshold so first correction can fire immediately
  let correctionInProgress = false;

  // Flag on message_end (user role)
  pi.on("message_end", async (event, _ctx) => {
    if (event.message.role !== "user") return;
    const text = getMessageText(event.message);
    if (!text) return;
    if (isCorrection(text, config)) {
      pendingCorrection = true;
    }
  });

  // Trigger on turn_end (we need full context: user correction + what agent said)
  pi.on("turn_end", async (event, ctx) => {
    if (!pendingCorrection) {
      turnsSinceLastCorrection++;
      return;
    }
    pendingCorrection = false;

    // Rate limit: max 1 correction save per 3 turns
    if (turnsSinceLastCorrection < 3) return;
    if (correctionInProgress) return;

    turnsSinceLastCorrection = 0;
    correctionInProgress = true;

    const correctionCtx = ctx as unknown as CorrectionContext;

    try {
      await updateGate.runExclusive(async () => {
        // Build conversation snapshot
        const entries = correctionCtx.sessionManager.getBranch();
        const parts: string[] = [];
        for (const entry of entries) {
          if (!entry || typeof entry !== "object" || (entry as { type?: string }).type !== "message") continue;
          const msg = (entry as { message: unknown }).message;
          const text = getMessageText(msg);
          if (!text) continue;
          const role = (msg as { role?: string }).role;
          const prefix = role === "user" ? "[USER]" : "[ASSISTANT]";
          parts.push(`${prefix}: ${text}`);
        }

        const recentParts = parts.slice(-6);
        const currentMemory = store.getMemoryEntries().join(ENTRY_DELIMITER);
        const currentUser = store.getUserEntries().join(ENTRY_DELIMITER);
        const currentProject = projectStore ? projectStore.getMemoryEntries().join(ENTRY_DELIMITER) : null;

        const userPromptSections = [
          REVIEW_USER_PROMPT,
          "",
          "The user just corrected the agent. Focus on extracting:",
          "1. User preference ('don't do X', 'always use Y instead')",
          "2. Wrong assumption the agent made",
          "3. Environment fact the agent got wrong",
          "",
          "--- Current Memory ---",
          currentMemory || "(empty)",
          "",
          "--- Current User Profile ---",
          currentUser || "(empty)",
        ];

        if (currentProject !== null) {
          userPromptSections.push(
            "",
            "--- Current Project Memory ---",
            currentProject || "(empty)",
          );
        }

        userPromptSections.push(
          "",
          "--- Recent Conversation ---",
          recentParts.join("\n\n"),
        );

        correctionCtx.ui.notify("🔧 Correction detected — saving memory…", "info");

        const result = await reviewAndApply(
          correctionCtx,
          REVIEW_SYSTEM_PROMPT,
          userPromptSections.join("\n"),
          store,
          projectStore,
          config,
          { timeoutMs: 30000 },
        );

        if (result.error) {
          correctionCtx.ui.notify("⚠️ Correction save failed (will retry on next correction)", "warning");
        } else if (result.applied > 0) {
          correctionCtx.ui.notify(`🔧 Correction saved to memory (${result.applied} entries)`, "info");
        }

        try {
          const lastUserMsg = recentParts.find((part) => part.startsWith("[USER]"));
          const correctionText = lastUserMsg ? lastUserMsg.replace(/^\[USER\]:\s*/, "") : "";
          if (!correctionText) return;

          const directive = extractCorrectionDirective(correctionText);
          const failureReason = "User corrected the agent";
          const scopedProjectName = projectStore ? projectName?.trim() || null : null;
          const addResult = await store.addFailure(directive, {
            category: "correction",
            failureReason,
            project: scopedProjectName ?? undefined,
          });

          if (!addResult.success || !dbManager) return;

          try {
            syncMemoryEntry(dbManager, {
              content: formatFailureMemoryContent(directive, {
                category: "correction",
                failureReason,
                project: scopedProjectName,
              }),
              target: "failure",
              project: scopedProjectName,
              category: "correction",
              failureReason,
            });
          } catch {
            // Best-effort — searchable sync should not block correction capture
          }
        } catch {
          // Best-effort — don't block the session
        }
      });
    } catch {
      // Best-effort — don't block the session
    } finally {
      correctionInProgress = false;
    }
  });
}
