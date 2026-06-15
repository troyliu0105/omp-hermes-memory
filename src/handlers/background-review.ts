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
 * Uses pi.exec("omp", ["-p", ...]) for isolated one-shot review,
 * keeping us within OMP's intended extension API.
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { MemoryStore } from "../store/memory-store.js";
import { COMBINED_REVIEW_PROMPT } from "../constants.js";
import type { MemoryConfig } from "../types.js";
import { applyRecentMessageLimit, collectMessageParts } from "./message-parts.js";
import { execChildPrompt } from "./pi-child-process.js";

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
): void {
  let turnsSinceReview = 0;
  let toolCallsSinceReview = 0;
  let userTurnCount = 0;
  let reviewInProgress = false;

  // Idle timer state. Timer handle type is an allowed exception to the
  // named-type rule (Node timer handles have no exported named type).
  const idleMs = config.idleReviewMs ?? 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let lastSeenCtx: ReviewContext | undefined;

  /** Shared review body — builds a conversation snapshot and spawns the child. */
  function runReview(ctx: ReviewContext, reason: ReviewReason): void {
    if (reviewInProgress) return;
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

    const reviewPrompt = [
      COMBINED_REVIEW_PROMPT,
      "",
      "--- Current Memory ---",
      currentMemory || "(empty)",
      "",
      "--- Current User Profile ---",
      currentUser || "(empty)",
    ];

    if (currentProject !== null) {
      reviewPrompt.push(
        "",
        "--- Current Project Memory ---",
        currentProject || "(empty)",
      );
    }

    reviewPrompt.push(
      "",
      "--- Conversation to Review ---",
      parts.join("\n\n"),
    );

    // Fire-and-forget: do NOT await. The review runs in a subprocess;
    // blocking turn_end would freeze the interactive chat.
    // Notifications are delivered via .then() once the subprocess completes.
    //
    // We intentionally omit ctx.signal — the signal is tied to the turn
    // lifetime and would abort the subprocess before it finishes now that
    // we're not awaiting. The timeout (120s) provides its own safety net.
    execChildPrompt(pi, reviewPrompt.join("\n"), config, {
      signal: undefined,
      timeoutMs: 120000,
    })
      .then((result) => {
        reviewInProgress = false;
        if (result.code === 0 && result.stdout) {
          const output = result.stdout.trim();
          if (output && !output.toLowerCase().includes("nothing to save")) {
            notify(ctx, "💾 Memory auto-reviewed and updated", "info");
          }
        } else if (result.code !== 0) {
          // Non-zero exit — surface it so the user knows the loop is alive
          // but hitting a transient failure (model unavailable, etc.).
          notify(ctx, "⚠️ Background review failed (will retry next cycle)", "warning");
        }
      })
      .catch(() => {
        // Best-effort: subprocess failures (timeout, signal, spawn errors)
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

  // Clean up the timer if the session is shutting down.
  pi.on("session_shutdown", async () => {
    clearIdleTimer();
  });
}
