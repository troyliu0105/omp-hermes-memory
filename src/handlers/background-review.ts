/**
 * Background review — learning loop that auto-saves memory.
 *
 * Three trigger sources, all routed through `runReview()`:
 *   1. Turn count   — every `nudgeInterval` turns.
 *   2. Tool calls   — every `nudgeToolCalls` tool-call blocks.
 *   3. Idle timeout — after `idleReviewMs` ms with no new user activity.
 *
 * Ported from hermes-agent/run_agent.py (_spawn_background_review,
 * _memory_nudge_interval). See PLAN.md → "Hermes Source File Reference Map".
 *
 * Uses in-process `completeSimple` from `@oh-my-pi/pi-ai` — no subprocess.
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { MemoryStore } from "../store/memory-store.js";
import { REVIEW_SYSTEM_PROMPT, REVIEW_USER_PROMPT } from "../constants.js";
import type { MemoryConfig } from "../types.js";
import { reviewAndApply } from "./llm-review.js";
import { MemoryUpdateGate } from "./memory-update-gate.js";
import { applyRecentMessageLimit, collectMessageParts } from "./message-parts.js";

/** Why a review is firing — surfaced in the user-facing notification. */
type ReviewReason = "turns" | "tool-calls" | "idle";

/**
 * Minimal slice of ExtensionContext that runReview needs. Declared explicitly
 * (not `any`) so the contract is precise at the boundary.
 */
interface ReviewContext {
  sessionManager: { getBranch(): unknown[] };
  ui: ExtensionContext["ui"];
  isIdle?(): boolean;
  model: ExtensionContext["model"];
  modelRegistry: ExtensionContext["modelRegistry"];
}

function notify(ctx: ReviewContext, message: string, level: "info" | "warning"): void {
  try {
    ctx.ui.notify(message, level);
  } catch {
    // UI may be unavailable in print/RPC mode — best-effort.
  }
}

export function setupBackgroundReview(
  pi: ExtensionAPI,
  store: MemoryStore,
  projectStore: MemoryStore | null,
  config: MemoryConfig,
  updateGate: MemoryUpdateGate,
): void {
  let turnsSinceReview = 0;
  let toolCallsSinceReview = 0;
  let userTurnCount = 0;
  let reviewInProgress = false;
  // Abort any in-flight LLM call when the session shuts down.
  const shutdownAbort = new AbortController();

  // Idle timer state. Timer handle type is an allowed exception to the
  // named-type rule (Node timer handles have no exported named type).
  const idleMs = config.idleReviewMs ?? 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let lastSeenCtx: ReviewContext | undefined;

  function runReview(ctx: ReviewContext, reason: ReviewReason): void {
    if (reviewInProgress) return;
    if (updateGate.isBusy()) return;
    if (userTurnCount < 3) return;

    // Build conversation snapshot from session entries (crash-safe)
    let allParts: string[] = [];
    try {
      const entries = ctx.sessionManager.getBranch();
      allParts = collectMessageParts(entries);
    } catch {
      return; // Session expired or empty — nothing to review
    }
    if (allParts.length < 4) {
      return; // Not enough conversation to review
    }

    reviewInProgress = true;
    turnsSinceReview = 0;
    toolCallsSinceReview = 0;

    const reasonLabel =
      reason === "turns" ? `${config.nudgeInterval} turns`
      : reason === "tool-calls" ? `${config.nudgeToolCalls} tool calls`
      : "idle";
    notify(ctx, `💾 Background review triggered (${reasonLabel})…`, "info");

    const parts = applyRecentMessageLimit(allParts, config.reviewRecentMessages);
    const currentMemory = store.getMemoryEntries().join("\n§\n");
    const currentUser = store.getUserEntries().join("\n§\n");
    const currentProject = projectStore ? projectStore.getMemoryEntries().join("\n§\n") : null;

    const userPromptSections = [
      REVIEW_USER_PROMPT,
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
      "--- Conversation to Review ---",
      parts.join("\n\n"),
    );

    updateGate.runIfIdle(async () => {
      return reviewAndApply(
        ctx,
        REVIEW_SYSTEM_PROMPT,
        userPromptSections.join("\n"),
        store,
        projectStore,
        config,
        { signal: shutdownAbort.signal, timeoutMs: 120000 },
      );
    })
      .then((result) => {
        reviewInProgress = false;
        if (!result) return;
        if (result.error) {
          notify(ctx, "⚠️ Background review failed (will retry next cycle)", "warning");
        } else if (!result.nothingToSave && result.applied > 0) {
          notify(ctx, `💾 Memory auto-reviewed and updated (${result.applied} entries saved)`, "info");
        }
      })
      .catch(() => {
        reviewInProgress = false;
        notify(ctx, "⚠️ Background review failed (will retry next cycle)", "warning");
      });
  }

  /** (Re)arm the idle timer after activity. Clears any pending timer first. */
  function armIdleTimer(ctx: ReviewContext): void {
    if (idleMs <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    lastSeenCtx = ctx;
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      // Re-fetch a live context: the captured one may be stale across turns.
      // If the agent is no longer idle (user typed something), skip.
      if (!lastSeenCtx) return;
      if (typeof lastSeenCtx.isIdle === "function" && !lastSeenCtx.isIdle()) return;
      runReview(lastSeenCtx, "idle");
    }, idleMs);
    // Don't keep the event loop alive solely for a background review.
    idleTimer.unref?.();
  }

  function clearIdleTimer(): void {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  }

  pi.on("message_end", async (event, _ctx) => {
    if (event.message.role === "user") {
      userTurnCount++;
    }
  });

  // New user input starts arriving — cancel any pending idle review so we
  // don't fire mid-turn.
  pi.on("message_start", async (_event, ctx) => {
    clearIdleTimer();
    lastSeenCtx = ctx as unknown as ReviewContext;
  });

  pi.on("turn_end", async (event, ctx) => {
    turnsSinceReview++;

    if (!config.reviewEnabled) return;

    // Count tool calls from this turn's message only (not cumulative branch scan —
    // otherwise the counter resets to 0 at review, then immediately re-counts all
    // historical tool calls and re-triggers on every subsequent turn).
    try {
      const msg = event.message;
      if (msg?.role === "assistant") {
        const content = msg?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && typeof block === "object" && block.type === "toolCall") {
              toolCallsSinceReview++;
            }
          }
        }
      }
    } catch {
      // If we can't count tool calls, fall back to turn-based only
    }

    const reviewCtx = ctx as unknown as ReviewContext;

    // Arm the idle timer after every turn end (no-op when idleMs <= 0).
    armIdleTimer(reviewCtx);

    // Trigger on EITHER turn count OR tool call count
    const turnThresholdMet = turnsSinceReview >= config.nudgeInterval;
    const toolCallThresholdMet = toolCallsSinceReview >= config.nudgeToolCalls;

    if (!turnThresholdMet && !toolCallThresholdMet) return;

    const reason: ReviewReason = turnThresholdMet ? "turns" : "tool-calls";
    clearIdleTimer();
    runReview(reviewCtx, reason);
  });

  // Clean up on shutdown: clear idle timer and abort any in-flight LLM call.
  pi.on("session_shutdown", async () => {
    clearIdleTimer();
    shutdownAbort.abort();
  });
}
