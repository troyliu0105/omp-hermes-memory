/**
 * Extracts referenced same-directory Markdown filenames from memory entries.
 *
 * Memory entries may point to detail files like "xxx，详情在 y_memory.md 中" or
 * "details in `y_memory.md`". This module finds those filenames so the store can
 * synchronize them alongside the primary memory object. The files themselves are
 * never injected into the system prompt — they exist for cross-device availability.
 */

import { MEMORY_FILE, USER_FILE } from "../constants.js";

const FAILURE_FILE = "failures.md";

const MARKDOWN_FILENAME = /[A-Za-z0-9][A-Za-z0-9._-]*\.md/g;
const SAFE_MEMORY_OBJECT_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

const PRIMARY_FILES: Record<string, true> = {
  [MEMORY_FILE.toLowerCase()]: true,
  [USER_FILE.toLowerCase()]: true,
  [FAILURE_FILE.toLowerCase()]: true,
};

/**
 * Scan memory entry text for same-directory Markdown filenames.
 *
 * - Catches plain text and backtick references such as
 *   `详情在 y_memory.md 中`, `details in y_memory.md`, and ``details in `y_memory.md``.
 * - Excludes primary files `MEMORY.md`, `USER.md`, and `failures.md`.
 * - Rejects unsafe names (slashes, `..`, leading `.`, non-Markdown extensions).
 * - Dedupes preserving first-seen order.
 */
export function extractReferencedMarkdownFiles(entries: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const entry of entries) {
    const matches = entry.matchAll(MARKDOWN_FILENAME);
    for (const match of matches) {
      const fileName = match[0];
      if (!SAFE_MEMORY_OBJECT_KEY.test(fileName)) continue;
      if (fileName.includes("/") || fileName.includes("\\") || fileName.includes("..")) continue;
      if (fileName.startsWith(".")) continue;
      if (PRIMARY_FILES[fileName.toLowerCase()]) continue;
      if (seen.has(fileName)) continue;
      seen.add(fileName);
      result.push(fileName);
    }
  }

  return result;
}
