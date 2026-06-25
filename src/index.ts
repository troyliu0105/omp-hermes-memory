/**
 * OMP Hermes Memory Extension
 *
 * Brings Hermes-style persistent memory and a learning loop to any Oh My Pi user.
 * After `omp plugin add`, users get:
 *
 * 1. Persistent Memory — MEMORY.md + USER.md that survive across sessions
 * 2. Background Learning Loop — auto-saves notable facts every N turns
 * 3. Session-End Flush — saves memories before compaction/shutdown
 * 4. Auto-Consolidation — merges memory when full instead of erroring
 * 5. Correction Detection — immediate save on user corrections
 * 6. Procedural Skills — SKILL.md files for reusable procedures
 * 7. Tool-Call-Aware Nudge — review triggers on tool call count too
 * 8. /memory-insights — shows what's stored
 * 9. /memory-skills — lists procedural skills
 * 10. /memory-consolidate — manual consolidation trigger
 * 11. /memory-interview — onboarding interview to pre-fill user profile
 * 12. /memory-switch-project — list project memories
 * 13. Context Fencing — <memory-context> tags prevent injection through stored memory
 * 14. Memory Aging — entry timestamps guide consolidation
 *
 * See docs/ROADMAP.md for full roadmap and Hermes competitive analysis.
 */

import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { MemoryStore } from "./store/memory-store.js";
import { createMemoryObjectStore, joinS3Path } from "./store/memory-store-factory.js";
import { SkillStore } from "./store/skill-store.js";
import { DatabaseManager } from "./store/db.js";
import { indexSession } from "./store/session-indexer.js";
import { parseSessionFile } from "./store/session-parser.js";
import { registerMemoryTool } from "./tools/memory-tool.js";
import { registerMemoryListTool } from "./tools/memory-list-tool.js";
import { registerSkillTool } from "./tools/skill-tool.js";
import { registerSessionSearchTool } from "./tools/session-search-tool.js";
import { registerMemorySearchTool } from "./tools/memory-search-tool.js";
import { setupBackgroundReview } from "./handlers/background-review.js";
import { setupSessionFlush } from "./handlers/session-flush.js";
import { registerInsightsCommand } from "./handlers/insights.js";
import { triggerConsolidation, registerConsolidateCommand } from "./handlers/auto-consolidate.js";
import { setupCorrectionDetector } from "./handlers/correction-detector.js";
import { registerSkillsCommand } from "./handlers/skills-command.js";
import { registerInterviewCommand } from "./handlers/interview.js";
import { registerSwitchProjectCommand } from "./handlers/switch-project.js";
import { registerIndexSessionsCommand } from "./handlers/index-sessions.js";
import { registerLearnMemoryCommand } from "./handlers/learn-memory.js";
import { registerSyncMarkdownMemoriesCommand, syncMarkdownMemoriesToSqlite } from "./handlers/sync-markdown-memories.js";
import { registerPreviewContextCommand } from "./handlers/preview-context.js";
import { MemoryUpdateGate } from "./handlers/memory-update-gate.js";
import { loadConfig } from "./config.js";
import { detectProject, detectProjectSkills } from "./project.js";
import { buildPromptContext } from "./prompt-context.js";
import { migrateLegacyProjectMemoryDirs } from "./project-memory-migration.js";
import { migrateExtensionRoot } from "./extension-root-migration.js";
import { AGENT_ROOT, HERMES_MEMORY_DIR_NAME } from "./paths.js";

export function resolveProjectSkillDiscovery(
  skillStore: SkillStore,
  projectsMemoryDir: string | undefined,
  cwd?: string,
): { skillPaths: string[] } {
  const detected = detectProjectSkills(projectsMemoryDir, cwd);
  skillStore.setProjectContext(detected.name, detected.skillsDir);

  const skillPaths = [skillStore.getGlobalSkillsDir()];
  if (detected.skillsDir) skillPaths.push(detected.skillsDir);

  return { skillPaths };
}

export function registerProjectSkillDiscoveryHandler(
  pi: Pick<ExtensionAPI, "on">,
  skillStore: SkillStore,
  projectsMemoryDir: string | undefined,
): void {
  pi.on("resources_discover", async (event, _ctx) => {
    return resolveProjectSkillDiscovery(skillStore, projectsMemoryDir, (event as { cwd?: string }).cwd);
  });
}

export default function (pi: ExtensionAPI) {
  const config = loadConfig();

  const agentRoot = AGENT_ROOT;
  const legacyGlobalDir = path.join(agentRoot, "memory");
  const defaultGlobalDir = path.join(agentRoot, HERMES_MEMORY_DIR_NAME);

  const configuredMemoryDir = config.memoryDir?.trim();
  const pointsToLegacyMemoryDir = configuredMemoryDir
    ? path.resolve(configuredMemoryDir) === path.resolve(legacyGlobalDir)
    : false;

  const globalDir = !configuredMemoryDir || pointsToLegacyMemoryDir
    ? defaultGlobalDir
    : configuredMemoryDir;

  const shouldMigrateExtensionRoot = !configuredMemoryDir || pointsToLegacyMemoryDir;
  let extensionRootMigrated = false;

  const globalObjectStore = createMemoryObjectStore(config, globalDir, "global");
  const store = new MemoryStore({ ...config, memoryDir: globalDir }, { objectStore: globalObjectStore });
  const project = detectProject(config.projectsMemoryDir);
  const projectName = project.name ?? "";
  const skillStore = new SkillStore({
    globalSkillsDir: path.join(globalDir, "skills"),
    projectSkillsDir: project.memoryDir ? path.join(project.memoryDir, "skills") : null,
    projectName: project.name,
    legacySkillsDir: path.join(legacyGlobalDir, "skills"),
    legacyPiGlobalSkillsDir: path.join(agentRoot, "skills"),
    migrationSentinelPath: path.join(globalDir, ".skills-migrated-to-extension-storage"),
  });
  const dbManager = new DatabaseManager(globalDir);

  const refreshSkillProjectContext = (cwd?: string) => {
    const resource = resolveProjectSkillDiscovery(skillStore, config.projectsMemoryDir, cwd);
    return {
      name: skillStore.getProjectName(),
      skillsDir: skillStore.getProjectSkillsDir(),
      resource,
    };
  };

  // Keep project memory available for users upgrading from the old
  // ~/.omp/agent/<project>/ layout. This is non-destructive: legacy folders
  // remain in place while entries are copied/merged into projects-memory/.
  migrateLegacyProjectMemoryDirs(agentRoot, config.projectsMemoryDir);

  // Detect project from cwd using shared helper
  // Project-scoped store: ~/.omp/agent/<projectsMemoryDir>/<project_name>/
  const projectConfig = project.memoryDir
    ? { ...config, memoryCharLimit: config.projectCharLimit, memoryDir: project.memoryDir }
    : { ...config, memoryDir: undefined };
  const projectStore = project.memoryDir
    ? new MemoryStore(
      projectConfig,
      {
        objectStore: createMemoryObjectStore(
          config,
          project.memoryDir,
          joinS3Path("projects", encodeURIComponent(projectName)),
        ),
      },
    )
    : null;

  // Per-session serialization for all memory updates.
  const memoryUpdateGate = new MemoryUpdateGate();

  // ── 1. Load memory from disk on session start ──
  pi.on("session_start", async (_event, ctx) => {
    if (shouldMigrateExtensionRoot && !extensionRootMigrated) {
      try {
        await migrateExtensionRoot(legacyGlobalDir, globalDir);
      } catch {
        // best effort migration only
      }
      extensionRootMigrated = true;
    }

    refreshSkillProjectContext(ctx.cwd);
    await skillStore.migrateLegacySkills();
    await skillStore.ensureDiscoveredRoots();
    await store.loadFromDisk();
    if (projectStore) await projectStore.loadFromDisk();
    try {
      syncMarkdownMemoriesToSqlite(dbManager, globalDir, config.projectsMemoryDir, agentRoot);
    } catch {
      // Best-effort only: failed SQLite backfill should not block extension startup.
    }
  });

  registerProjectSkillDiscoveryHandler(pi, skillStore, config.projectsMemoryDir);

  // ── 2. Inject memory policy by default; legacy mode keeps full frozen memory blocks ──
  pi.on("before_agent_start", async (event, _ctx) => {
    const promptContext = await buildPromptContext(config, store, projectStore, projectName);

    if (promptContext) {
      return {
        systemPrompt: [...event.systemPrompt, promptContext],
      };
    }
  });

  // ── 3. Register the memory tool (with project store + SQLite sync) ──
  registerMemoryTool(pi, store, projectStore, dbManager, projectName);
  registerMemoryListTool(pi, store, projectStore, projectName);

  // ── 4. Register the skill tool (toggleable via config) ──
  if (config.skillToolEnabled) {
    registerSkillTool(pi, skillStore);
  }

  // ── 5. Setup background learning loop (with tool-call-aware nudge) ──
  setupBackgroundReview(pi, store, projectStore, config, memoryUpdateGate);

  // ── 6. Setup session-end flush ──
  setupSessionFlush(pi, store, projectStore, config, memoryUpdateGate);

  // ── 7. Setup auto-consolidation (inject consolidator into stores) ──
  // The consolidator runs from within MemoryStore._add(), which is deep inside
  // event handlers. We capture the latest ExtensionContext via a mutable holder
  // so the in-process LLM call can resolve model + API key.
  let latestCtx: import("@oh-my-pi/pi-coding-agent/extensibility/extensions/types").ExtensionContext | null = null;
  pi.on("turn_end", async (_event, ctx) => { latestCtx = ctx; });
  pi.on("session_start", async (_event, ctx) => { latestCtx = ctx; });
  pi.on("session_before_compact", async (_event, ctx) => { latestCtx = ctx; });
  const ctxProvider = () => latestCtx;

  store.setConsolidator(async (target, signal) => {
    return triggerConsolidation(
      ctxProvider,
      store,
      target,
      memoryUpdateGate,
      signal,
      config.consolidationTimeoutMs,
      target,
      config,
    );
  });
  if (projectStore) {
    projectStore.setConsolidator(async (target, signal) => {
      const toolTarget = target === "memory" ? "project" : target;
      return triggerConsolidation(
        ctxProvider,
        projectStore,
        target,
        memoryUpdateGate,
        signal,
        config.consolidationTimeoutMs,
        toolTarget,
        config,
        undefined,
        projectStore,
        projectName,
      );
    });
  }
  registerConsolidateCommand(
    pi,
    store,
    config.consolidationTimeoutMs,
    projectStore,
    projectName,
    config,
    ctxProvider,
    memoryUpdateGate,
  );

  // ── 8. Setup correction detection ──
  setupCorrectionDetector(pi, store, projectStore, config, memoryUpdateGate, dbManager, projectName);

  // ── 9. Register commands ──
  registerInsightsCommand(pi, store, projectStore, projectName);
  registerSkillsCommand(pi, skillStore);
  registerInterviewCommand(pi, store);
  registerSwitchProjectCommand(pi, config);
  registerLearnMemoryCommand(pi);
  registerSyncMarkdownMemoriesCommand(pi, dbManager, globalDir, config.projectsMemoryDir, agentRoot);
  registerPreviewContextCommand(pi, store, projectStore, projectName, config);

  // ── 10. SQLite session search + extended memory ──
  registerSessionSearchTool(pi, dbManager, config.sessionSearch ?? { variant: "legacy" });
  registerMemorySearchTool(pi, dbManager);
  registerIndexSessionsCommand(pi, globalDir);

  // ── 11. Auto-index session on shutdown ──
  // Ordering is safe: OMP's ExtensionRunner.emit() runs same-extension handlers
  // sequentially in registration order and awaits each one, so any DB writes
  // above fully complete before close() runs. WARNING: do not register another
  // DB-writing session_shutdown handler after this block — it would run after
  // close() and silently no-op.
  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (sessionFile && require("node:fs").existsSync(sessionFile)) {
        const sessionData = parseSessionFile(sessionFile);
        if (sessionData) {
          indexSession(dbManager, sessionData);
        }
      }
    } catch {
      // Silent fail — don't block shutdown
    } finally {
      try { dbManager.close(); } catch { /* best effort — never block shutdown */ }
    }
  });
}
