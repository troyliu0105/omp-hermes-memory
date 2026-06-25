import * as fs from "node:fs";
import * as path from "node:path";
import type { MemoryConfig, MemoryOverflowStrategy, SessionSearchVariant, ThinkingLevel } from "./types.js";
import {
  DEFAULT_MEMORY_CHAR_LIMIT,
  DEFAULT_USER_CHAR_LIMIT,
  DEFAULT_PROJECT_CHAR_LIMIT,
  DEFAULT_PROJECTS_MEMORY_DIR,
  DEFAULT_NUDGE_INTERVAL,
  DEFAULT_FLUSH_MIN_TURNS,
  DEFAULT_NUDGE_TOOL_CALLS,
  DEFAULT_REVIEW_RECENT_MESSAGES,
  DEFAULT_FLUSH_RECENT_MESSAGES,
  DEFAULT_CONSOLIDATION_TIMEOUT_MS,
  DEFAULT_IDLE_REVIEW_MS,
  DEFAULT_FAILURE_INJECTION_MAX_AGE_DAYS,
  DEFAULT_FAILURE_INJECTION_MAX_ENTRIES,
} from "./constants.js";
import {
  normalizeConfiguredMemoryDir,
  normalizeProjectsMemoryDir,
  OMP_CONFIG_PATH,
  OMP_CONFIG_PATH_LEGACY,
} from "./paths.js";

const MEMORY_OVERFLOW_STRATEGIES: readonly MemoryOverflowStrategy[] = ["auto-consolidate", "reject", "fifo-evict"];
const SESSION_SEARCH_VARIANTS: readonly SessionSearchVariant[] = ["legacy", "anchors"];
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

function isMemoryOverflowStrategy(value: unknown): value is MemoryOverflowStrategy {
  return typeof value === "string" && MEMORY_OVERFLOW_STRATEGIES.includes(value as MemoryOverflowStrategy);
}

function isSessionSearchVariant(value: unknown): value is SessionSearchVariant {
  return typeof value === "string" && SESSION_SEARCH_VARIANTS.includes(value as SessionSearchVariant);
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel);
}

const DEFAULT_CONFIG: MemoryConfig = {
  memoryMode: "policy-only",
  memoryPolicyStyle: "full",
  memoryCharLimit: DEFAULT_MEMORY_CHAR_LIMIT,
  userCharLimit: DEFAULT_USER_CHAR_LIMIT,
  projectCharLimit: DEFAULT_PROJECT_CHAR_LIMIT,
  nudgeInterval: DEFAULT_NUDGE_INTERVAL,
  reviewRecentMessages: DEFAULT_REVIEW_RECENT_MESSAGES,
  reviewEnabled: true,
  flushOnCompact: true,
  flushOnShutdown: true,
  flushMinTurns: DEFAULT_FLUSH_MIN_TURNS,
  flushRecentMessages: DEFAULT_FLUSH_RECENT_MESSAGES,
  memoryOverflowStrategy: "auto-consolidate",
  autoConsolidate: true,
  correctionDetection: true,
  failureInjectionEnabled: true,
  failureInjectionMaxAgeDays: DEFAULT_FAILURE_INJECTION_MAX_AGE_DAYS,
  failureInjectionMaxEntries: DEFAULT_FAILURE_INJECTION_MAX_ENTRIES,
  nudgeToolCalls: DEFAULT_NUDGE_TOOL_CALLS,
  skillToolEnabled: true,
  idleReviewMs: DEFAULT_IDLE_REVIEW_MS,
  consolidationTimeoutMs: DEFAULT_CONSOLIDATION_TIMEOUT_MS,
  projectsMemoryDir: DEFAULT_PROJECTS_MEMORY_DIR,
  sessionSearch: { variant: "legacy" },
  storage: { backend: "local" },
};
export const DEFAULT_CONFIG_PATH = OMP_CONFIG_PATH;
/** Search order: primary (extension dir) → legacy (pre-v0.8 flat path). */
export const DEFAULT_CONFIG_PATHS = [OMP_CONFIG_PATH, OMP_CONFIG_PATH_LEGACY] as const;

function applyParsedConfig(config: MemoryConfig, parsed: Record<string, unknown>): void {
  const isNonNegativeNumber = (value: unknown): value is number => (
    typeof value === "number" && Number.isFinite(value) && value >= 0
  );
  const isStringArray = (value: unknown): value is string[] => (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
  const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === "object" && value !== null
  );
  let hasLegacyAutoConsolidate = false;
  let hasMemoryOverflowStrategy = false;

  if (parsed.memoryMode === "policy-only" || parsed.memoryMode === "legacy-inject") config.memoryMode = parsed.memoryMode;
  if (
    parsed.memoryPolicyStyle === "full"
    || parsed.memoryPolicyStyle === "compact"
    || parsed.memoryPolicyStyle === "custom"
    || parsed.memoryPolicyStyle === "none"
  ) config.memoryPolicyStyle = parsed.memoryPolicyStyle;
  if (typeof parsed.memoryPolicyCustomText === "string") config.memoryPolicyCustomText = parsed.memoryPolicyCustomText;
  if (typeof parsed.memoryCharLimit === "number") config.memoryCharLimit = parsed.memoryCharLimit;
  if (typeof parsed.userCharLimit === "number") config.userCharLimit = parsed.userCharLimit;
  if (typeof parsed.nudgeInterval === "number") config.nudgeInterval = parsed.nudgeInterval;
  if (isNonNegativeNumber(parsed.reviewRecentMessages)) config.reviewRecentMessages = parsed.reviewRecentMessages;
  if (typeof parsed.reviewEnabled === "boolean") config.reviewEnabled = parsed.reviewEnabled;
  if (typeof parsed.flushOnCompact === "boolean") config.flushOnCompact = parsed.flushOnCompact;
  if (typeof parsed.flushOnShutdown === "boolean") config.flushOnShutdown = parsed.flushOnShutdown;
  if (typeof parsed.flushMinTurns === "number") config.flushMinTurns = parsed.flushMinTurns;
  if (isNonNegativeNumber(parsed.flushRecentMessages)) config.flushRecentMessages = parsed.flushRecentMessages;
  if (typeof parsed.autoConsolidate === "boolean") {
    config.autoConsolidate = parsed.autoConsolidate;
    hasLegacyAutoConsolidate = true;
  }
  if (isMemoryOverflowStrategy(parsed.memoryOverflowStrategy)) {
    config.memoryOverflowStrategy = parsed.memoryOverflowStrategy;
    hasMemoryOverflowStrategy = true;
  }
  if (typeof parsed.correctionDetection === "boolean") config.correctionDetection = parsed.correctionDetection;
  if (isStringArray(parsed.correctionStrongPatterns)) config.correctionStrongPatterns = parsed.correctionStrongPatterns;
  if (isStringArray(parsed.correctionWeakPatterns)) config.correctionWeakPatterns = parsed.correctionWeakPatterns;
  if (isStringArray(parsed.correctionNegativePatterns)) config.correctionNegativePatterns = parsed.correctionNegativePatterns;
  if (isStringArray(parsed.correctionDirectiveWords)) config.correctionDirectiveWords = parsed.correctionDirectiveWords;
  if (typeof parsed.consolidationTimeoutMs === "number") config.consolidationTimeoutMs = parsed.consolidationTimeoutMs;
  if (typeof parsed.failureInjectionEnabled === "boolean") config.failureInjectionEnabled = parsed.failureInjectionEnabled;
  if (typeof parsed.failureInjectionMaxAgeDays === "number") config.failureInjectionMaxAgeDays = parsed.failureInjectionMaxAgeDays;
  if (typeof parsed.failureInjectionMaxEntries === "number") config.failureInjectionMaxEntries = parsed.failureInjectionMaxEntries;
  if (typeof parsed.nudgeToolCalls === "number") config.nudgeToolCalls = parsed.nudgeToolCalls;
  if (typeof parsed.skillToolEnabled === "boolean") config.skillToolEnabled = parsed.skillToolEnabled;
  if (isNonNegativeNumber(parsed.idleReviewMs)) config.idleReviewMs = parsed.idleReviewMs;
  if (typeof parsed.projectCharLimit === "number") config.projectCharLimit = parsed.projectCharLimit;
  if (typeof parsed.memoryDir === "string") {
    const normalizedMemoryDir = normalizeConfiguredMemoryDir(parsed.memoryDir);
    if (normalizedMemoryDir) config.memoryDir = normalizedMemoryDir;
  }
  if (typeof parsed.projectsMemoryDir === "string") {
    const normalizedProjectsMemoryDir = normalizeProjectsMemoryDir(parsed.projectsMemoryDir);
    if (normalizedProjectsMemoryDir) config.projectsMemoryDir = normalizedProjectsMemoryDir;
  }
  if (
    typeof parsed.sessionSearch === "object"
    && parsed.sessionSearch !== null
    && isSessionSearchVariant((parsed.sessionSearch as { variant?: unknown }).variant)
  ) {
    config.sessionSearch = { variant: (parsed.sessionSearch as { variant: SessionSearchVariant }).variant };
  }
  if (isRecord(parsed.storage)) {
    if (parsed.storage.backend === "local") {
      config.storage = { backend: "local" };
    } else if (parsed.storage.backend === "s3" && isRecord(parsed.storage.s3)) {
      const endpoint = typeof parsed.storage.s3.endpoint === "string" ? parsed.storage.s3.endpoint.trim() : "";
      const accessKey = typeof parsed.storage.s3.access_key === "string" ? parsed.storage.s3.access_key.trim() : "";
      const secretKey = typeof parsed.storage.s3.secret_key === "string" ? parsed.storage.s3.secret_key.trim() : "";
      const bucket = typeof parsed.storage.s3.bucket === "string" ? parsed.storage.s3.bucket.trim() : "";
      const path = typeof parsed.storage.s3.path === "string" ? parsed.storage.s3.path.trim() : undefined;
      const region = typeof parsed.storage.s3.region === "string" ? parsed.storage.s3.region.trim() : "";
      const forcePathStyle = parsed.storage.s3.forcePathStyle;
      const localCache = parsed.storage.s3.local_cache;

      if (
        endpoint.length > 0
        && accessKey.length > 0
        && secretKey.length > 0
        && bucket.length > 0
        && path !== undefined
      ) {
        config.storage = {
          backend: "s3",
          s3: {
            endpoint,
            accessKey,
            secretKey,
            bucket,
            path,
            ...(region.length > 0 ? { region } : {}),
            ...(typeof forcePathStyle === "boolean" ? { forcePathStyle } : {}),
            ...(typeof localCache === "boolean" ? { localCache } : {}),
          },
        };
      }
    }
  }
  if (typeof parsed.llmModelOverride === "string") {
    const trimmed = parsed.llmModelOverride.trim();
    if (trimmed.length > 0) config.llmModelOverride = trimmed;
  }
  if (isThinkingLevel(parsed.llmThinkingOverride)) config.llmThinkingOverride = parsed.llmThinkingOverride;
  if (hasMemoryOverflowStrategy) {
    config.autoConsolidate = config.memoryOverflowStrategy === "auto-consolidate";
  } else if (hasLegacyAutoConsolidate) {
    config.memoryOverflowStrategy = config.autoConsolidate ? "auto-consolidate" : "reject";
  }
}
function mergeConfigFile(config: MemoryConfig, configPath: string): void {
  try {
    if (!fs.existsSync(configPath)) return;
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return;
    applyParsedConfig(config, parsed as Record<string, unknown>);
  } catch {
    // Ignore parse and access errors for compatibility.
  }
}

/**
 * Build the default config file body with inline documentation and explicit
 * (empty) model override fields so users discover them. Model fields are
 * emitted as empty strings so they serialize and invite configuration.
 */
function buildDefaultConfigTemplate(): Record<string, unknown> {
  return {
    "//": "OMP Hermes Memory — edit and restart OMP. Remove a key to restore its default.",
    memoryMode: DEFAULT_CONFIG.memoryMode,
    memoryPolicyStyle: DEFAULT_CONFIG.memoryPolicyStyle,
    memoryCharLimit: DEFAULT_CONFIG.memoryCharLimit,
    userCharLimit: DEFAULT_CONFIG.userCharLimit,
    projectCharLimit: DEFAULT_CONFIG.projectCharLimit,
    projectsMemoryDir: DEFAULT_CONFIG.projectsMemoryDir,
    "// storage": "local keeps Markdown on disk. s3 stores global memory, active project memory, and referenced same-directory Markdown detail files through an S3-compatible bucket. Set storage.s3.local_cache=false for S3-only memory with no local Markdown mirror; leave it true for offline fallback. Generic S3-compatible endpoints default to us-east-1; Cloudflare R2 can use region=auto.",
    storage: DEFAULT_CONFIG.storage,

    "// learning-loop": "Background review auto-saves memory every N turns, every N tool calls, or after N ms idle.",
    reviewEnabled: DEFAULT_CONFIG.reviewEnabled,
    nudgeInterval: DEFAULT_CONFIG.nudgeInterval,
    nudgeToolCalls: DEFAULT_CONFIG.nudgeToolCalls,
    idleReviewMs: DEFAULT_CONFIG.idleReviewMs,
    reviewRecentMessages: DEFAULT_CONFIG.reviewRecentMessages ?? 0,

    "// model": "Override the model used for background review / consolidation subprocesses. Empty = inherit the active model.",
    llmModelOverride: "",
    llmThinkingOverride: "off",

    "// flush": "Save memories before compaction / shutdown.",
    flushOnCompact: DEFAULT_CONFIG.flushOnCompact,
    flushOnShutdown: DEFAULT_CONFIG.flushOnShutdown,
    flushMinTurns: DEFAULT_CONFIG.flushMinTurns,
    flushRecentMessages: DEFAULT_CONFIG.flushRecentMessages ?? 0,

    "// overflow": "Strategy when memory is full: auto-consolidate | reject | fifo-evict.",
    memoryOverflowStrategy: DEFAULT_CONFIG.memoryOverflowStrategy,

    "// correction": "Detect user corrections and save immediately.",
    correctionDetection: DEFAULT_CONFIG.correctionDetection,

    "// failure-injection": "Inject recent failure memories into the system prompt.",
    failureInjectionEnabled: DEFAULT_CONFIG.failureInjectionEnabled,
    failureInjectionMaxAgeDays: DEFAULT_CONFIG.failureInjectionMaxAgeDays,
    failureInjectionMaxEntries: DEFAULT_CONFIG.failureInjectionMaxEntries,

    consolidationTimeoutMs: DEFAULT_CONFIG.consolidationTimeoutMs,
    "// skills": "Expose the skill_manage tool to the agent. Disable to prevent any skill creation/updates.",
    skillToolEnabled: DEFAULT_CONFIG.skillToolEnabled,
    sessionSearch: DEFAULT_CONFIG.sessionSearch,
  };
}

/**
 * Write the default config file atomically (temp + rename) so the first run
 * gives users a discoverable, fully-documented configuration. Only the primary
 * default path is ever written; legacy paths and explicit `configPath` args
 * (used by tests) are read-only. Best-effort: failures are silently ignored.
 */
function ensureDefaultConfigFile(configPath: string): void {
  if (configPath !== OMP_CONFIG_PATH) return;
  try {
    if (fs.existsSync(configPath)) return;
    const dir = path.dirname(configPath);
    fs.mkdirSync(dir, { recursive: true });
    const body = JSON.stringify(buildDefaultConfigTemplate(), null, 2) + "\n";
    const tmp = `${configPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body, "utf-8");
    fs.renameSync(tmp, configPath);
  } catch {
    // Best-effort — missing config file is not fatal.
  }
}

export function loadConfig(configPath?: string): MemoryConfig {
  const usingDefaultPaths = configPath === undefined;
  const config: MemoryConfig = { ...DEFAULT_CONFIG };
  const configPaths = configPath ? [configPath] : [...DEFAULT_CONFIG_PATHS];

  if (usingDefaultPaths) {
    ensureDefaultConfigFile(OMP_CONFIG_PATH);
  }

  for (const p of configPaths) {
    mergeConfigFile(config, p);
  }

  return config;
}
