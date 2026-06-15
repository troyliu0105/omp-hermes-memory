import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_PROJECTS_MEMORY_DIR } from "./constants.js";

/**
 * Resolve the agent config directory, honoring the same environment variables
 * OMP's own `pi-utils/dirs.ts` uses:
 *   - PI_CODING_AGENT_DIR: override the entire agent directory
 *   - PI_CONFIG_DIR: override the config dir name (default ".omp")
 * This is the OMP equivalent of the Pi-era PI_CODING_AGENT_DIR-only resolver.
 */
export function resolveAgentRoot(env: Record<string, string | undefined> = process.env): string {
  const agentOverride = env.PI_CODING_AGENT_DIR?.trim();
  if (agentOverride) return path.resolve(expandHome(agentOverride));
  const configDirName = env.PI_CONFIG_DIR?.trim() || ".omp";
  return path.join(os.homedir(), configDirName, "agent");
}

export const AGENT_ROOT = resolveAgentRoot();
export const HERMES_MEMORY_DIR_NAME = "omp-hermes-memory";
/** Primary config path: lives inside the extension's own storage directory. */
export const OMP_CONFIG_PATH = path.join(AGENT_ROOT, HERMES_MEMORY_DIR_NAME, "omp-hermes-memory.json");
/** Legacy config path (pre-v0.8): read for backward compatibility, never written. */
export const OMP_CONFIG_PATH_LEGACY = path.join(AGENT_ROOT, "hermes-memory-config.json");
export const OMP_SESSIONS_DIR = path.join(AGENT_ROOT, "sessions");

export function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function normalizeConfiguredMemoryDir(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;

  const expanded = expandHome(trimmed);
  if (path.isAbsolute(expanded)) return path.normalize(expanded);
  return path.resolve(AGENT_ROOT, expanded);
}

function isSafeRelativeDirectory(input: string): boolean {
  const segments = input.split(/[\\/]+/).filter(Boolean);
  return segments.length === 1 && segments[0] !== "." && segments[0] !== "..";
}

export function normalizeProjectsMemoryDir(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;

  const expanded = expandHome(trimmed);
  let relative = expanded;

  if (path.isAbsolute(expanded)) {
    const resolved = path.resolve(expanded);
    const relativeToAgentRoot = path.relative(AGENT_ROOT, resolved);
    if (
      relativeToAgentRoot === ""
      || relativeToAgentRoot.startsWith("..")
      || path.isAbsolute(relativeToAgentRoot)
    ) {
      return undefined;
    }
    relative = relativeToAgentRoot;
  }

  const normalized = path.normalize(relative).replace(/^[\\/]+|[\\/]+$/g, "");
  if (!isSafeRelativeDirectory(normalized)) return undefined;
  return normalized;
}

export function resolveProjectsRoot(projectsMemoryDir = DEFAULT_PROJECTS_MEMORY_DIR): string {
  const normalized = normalizeProjectsMemoryDir(projectsMemoryDir) ?? DEFAULT_PROJECTS_MEMORY_DIR;
  return path.join(AGENT_ROOT, normalized);
}

export function resolvePreferredSessionDir(): string {
  return OMP_SESSIONS_DIR;
}

export function resolveAllSessionDirs(): string[] {
  return [OMP_SESSIONS_DIR];
}
