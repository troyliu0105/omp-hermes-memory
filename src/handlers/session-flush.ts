/**
 * Session flush — gives the agent one turn to save memories before context is lost.
 * Ported from hermes-agent/run_agent.py (flush_memories).
 * See PLAN.md → "Hermes Source File Reference Map" for source lines.
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { MemoryStore } from "../store/memory-store.js";
import { FLUSH_PROMPT } from "../constants.js";
import type { MemoryConfig } from "../types.js";
import { collectMessageParts } from "./message-parts.js";
import { execChildPrompt } from "./pi-child-process.js";

/** Minimal context slice flush needs — explicit at the boundary. */
interface FlushContext {
  sessionManager: { getBranch(): unknown[] };
  ui: ExtensionContext["ui"];
}

function safeNotify(ctx: FlushContext, message: string, level: "info" | "warning"): void {
  try {
    ctx.ui.notify(message, level);
  } catch {
    // UI may be unavailable (print/RPC mode, or test mocks without ui).
}
}

export function setupSessionFlush(
  pi: ExtensionAPI,
  store: MemoryStore,
  projectStore: MemoryStore | null,
  config: MemoryConfig,
): void {
  let userTurnCount = 0;

  pi.on("message_end", async (event, _ctx) => {
    if (event.message.role === "user") userTurnCount++;
  });

  /** Shared flush logic — builds conversation snapshot and spawns omp -p */
  async function flush(ctx: FlushContext, signal?: AbortSignal, timeoutMs = 30000): Promise<void> {
    if (userTurnCount < config.flushMinTurns) return;

    let entries;
    try {
      entries = ctx.sessionManager.getBranch();
    } catch {
      return; // Context already stale
    }

    const parts = collectMessageParts(entries, config.flushRecentMessages);
    const flushMessage = [
      FLUSH_PROMPT,
      "",
      "--- Conversation ---",
      parts.join("\n\n"),
    ].join("\n");

    try {
      safeNotify(ctx, "💾 Saving memories before context reset…", "info");
      await execChildPrompt(pi, flushMessage, config, {
        signal,
        timeoutMs,
      });
      safeNotify(ctx, "💾 Memories saved", "info");
    } catch {
      safeNotify(ctx, "⚠️ Memory flush failed (some memories may not be saved)", "warning");
    }
  }

  // Flush before compaction (can afford to wait)
  pi.on("session_before_compact", async (event, ctx) => {
    if (!config.flushOnCompact) return;
    await flush(ctx, event.signal, 30000);
  });

  // Flush before session shutdown (must be fast, non-blocking)
  pi.on("session_shutdown", async (_event, ctx) => {
    if (!config.flushOnShutdown) return;
    // Fire-and-forget with a short timeout so we don't block OMP's shutdown.
    // We intentionally do NOT await — OMP should not wait for the child process.
    flush(ctx, undefined, 10000).catch(() => {});
  });
}
