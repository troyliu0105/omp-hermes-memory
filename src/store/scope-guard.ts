/**
 * Scope guard — heuristics that detect project-specific content and prevent it
 * from being written into global USER.md / MEMORY.md.
 *
 * The LLM is instructed via prompts to route repo-specific facts to the
 * "project" target, but prompts are not reliable. This module provides a
 * high-confidence backstop: when content matches strong project signals, the
 * add path rejects it with a redirect to target="project".
 *
 * Design principle: only reject on HIGH-confidence signals. The cost of a
 * false positive (blocking a legitimate global memory) is a confusing error;
 * the cost of a false negative (letting project content into global memory) is
 * remediable later. We err on the side of blocking only obvious cases.
 */

export interface ScopeViolation {
  violated: true;
  detectedSignals: string[];
  suggestedTarget: "project";
}

export interface ScopeOk {
  violated: false;
}

export type ScopeCheckResult = ScopeViolation | ScopeOk;

/**
 * Strong project-content signals. Each regex is deliberately anchored to a
 * structural pattern rather than loose keywords, to minimize false positives.
 *
 * A single match on any pattern is enough to flag the content, but we collect
 * which signals fired so the error message is actionable.
 */
const STRONG_PROJECT_SIGNALS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  // Absolute or home-relative file paths: /foo/bar, ~/.omp/..., C:\Users
  { name: "file path", pattern: /(?:^|\s)(?:\/[\w.-]+){2,}|~\/[\w.-]+(?:\/[\w.-]+)+|[A-Za-z]:\\[^\s]+/ },
  // Relative source paths common in code: src/foo, tests/bar.ts, docs/x.md
  { name: "source path", pattern: /\b(?:src|tests|test|docs|lib|scripts|cmd|pkg|internal)\b\/[\w./-]+\.(?:ts|js|py|go|rs|java|md|json|yml|yaml|toml)\b/ },
  // Code identifiers: function foo(), class Bar {, const x =, import x from
  { name: "code identifier", pattern: /\b(?:function|class|def|const|let|var|import|export|interface|type|enum)\s+\w+/ },
  // Import/module specifiers: ./foo, ../bar, @scope/pkg, pkg/sub
  { name: "module specifier", pattern: /(?:\.\.?\/[\w./-]+)|(?:@[a-z][\w-]*\/[a-z][\w-]*)/ },
  // Explicit project self-references (English + Chinese). \b does not work on
  // CJK, so the Chinese variants are unanchored alternations.
  { name: "project self-reference", pattern: /(?:\b(?:this repo|this project|the repo|the project|our repo)\b)|(?:这个|本|当前|该)(?:仓库|项目)|(?:仓库|项目)(?:里的|中的)/ },
  { name: "repo reference", pattern: /\b[a-z][\w-]*\/[a-z][\w-]*\b/i },
  // Semantic versions: v1.2.3, 1.2.3, v0.10.0-beta.1
  { name: "version number", pattern: /\bv?\d+\.\d+\.\d+(?:-[\w.]+)?\b/ },
  // Explicit project self-references
  { name: "project self-reference", pattern: /\b(?:this repo|this project|the repo|the project|our repo)\b/i },
  // Config files and build artifacts by name
  { name: "config artifact", pattern: /\b(?:package\.json|tsconfig\.json|wrangler\.(?:toml|jsonc?)|Cargo\.toml|go\.mod|pom\.xml|build\.gradle|docker-compose|Dockerfile|\.env|Makefile|pyproject\.toml)\b/ },
  // Git-specific: branch names, commit refs
  { name: "git ref", pattern: /\b(?:branch|commit|PR|MR|merge request) [\w./#-]+\b/i },
  // Shell commands with project tooling: npm/pnpm/cargo/go/python -m
  { name: "build command", pattern: /\b(?:npm|pnpm|yarn|cargo|go|pip|poetry|make|docker|kubectl|terraform)\s+(?:install|run|build|test|deploy|exec|sync)\b/ },
];

/**
 * Check whether content looks project-specific.
 *
 * @param content - The memory entry text to check.
 * @returns `ScopeViolation` with detected signals if the content should be
 *          routed to project memory, otherwise `ScopeOk`.
 *
 * @example
 * checkScopeViolation("omp-hermes-memory uses S3 at src/store/s3.ts", "user")
 * // => { violated: true, detectedSignals: ["source path"], suggestedTarget: "project" }
 */
export function checkScopeViolation(content: string): ScopeCheckResult {
  const detectedSignals: string[] = [];
  for (const { name, pattern } of STRONG_PROJECT_SIGNALS) {
    if (pattern.test(content)) {
      detectedSignals.push(name);
    }
  }

  if (detectedSignals.length === 0) {
    return { violated: false };
  }

  return {
    violated: true,
    detectedSignals,
    suggestedTarget: "project",
  };
}

/**
 * Build a human-readable error message for a scope violation, guiding the
 * caller to the correct target.
 */
export function scopeViolationMessage(
  rawTarget: "memory" | "user",
  signals: string[],
): string {
  const targetLabel = rawTarget === "user" ? "USER.md" : "global MEMORY.md";
  const signalList = signals.join(", ");
  return (
    `This entry looks project-specific (signals: ${signalList}) and does not belong in ${targetLabel}. ` +
    `Use target="project" instead so it is scoped to the active repository. ` +
    `USER.md is for person-level facts only (identity, role, preferences across projects); ` +
    `global MEMORY.md is for cross-project environment/tool facts only.`
  );
}
