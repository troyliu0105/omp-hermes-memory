/**
 * Index sessions command — /memory-index-sessions imports past sessions into SQLite.
 */

import path from 'node:path';
import fs from 'node:fs';
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { DatabaseManager } from '../store/db.js';
import { indexAllSessions, getSessionStats, type BulkIndexResult } from '../store/session-indexer.js';
import { resolveAllSessionDirs } from '../paths.js';

function countSessionFiles(sessionsDir: string): { totalFiles: number; projectDirs: string[] } {
  let totalFiles = 0;
  let projectDirs: string[] = [];

  if (!fs.existsSync(sessionsDir)) return { totalFiles, projectDirs };

  projectDirs = fs.readdirSync(sessionsDir)
    .filter((dir) => fs.statSync(path.join(sessionsDir, dir)).isDirectory());

  for (const dir of projectDirs) {
    const files = fs.readdirSync(path.join(sessionsDir, dir))
      .filter((file) => file.endsWith('.jsonl'));
    totalFiles += files.length;
  }

  return { totalFiles, projectDirs };
}

function mergeResults(results: BulkIndexResult[]): BulkIndexResult {
  return results.reduce<BulkIndexResult>((merged, current) => {
    merged.sessionsProcessed += current.sessionsProcessed;
    merged.sessionsIndexed += current.sessionsIndexed;
    merged.sessionsSkipped += current.sessionsSkipped;
    merged.messagesIndexed += current.messagesIndexed;
    merged.errors.push(...current.errors);
    return merged;
  }, {
    sessionsProcessed: 0,
    sessionsIndexed: 0,
    sessionsSkipped: 0,
    messagesIndexed: 0,
    errors: [],
  });
}

export function registerIndexSessionsCommand(pi: ExtensionAPI, memoryDir: string): void {
  pi.registerCommand("memory-index-sessions", {
    description: "Import past OMP sessions into the search database",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      ctx.ui.notify('🔍 Scanning session directories...', 'info');

      try {
        const sessionDirs = resolveAllSessionDirs();
        const counts = sessionDirs.map((sessionsDir) => ({ sessionsDir, ...countSessionFiles(sessionsDir) }));
        const totalFiles = counts.reduce((sum, item) => sum + item.totalFiles, 0);
        const totalProjects = counts.reduce((sum, item) => sum + item.projectDirs.length, 0);

        ctx.ui.notify(`📁 Found ${totalFiles} session files across ${totalProjects} project directories\n⏳ Indexing...`, 'info');

        const dbManager = new DatabaseManager(memoryDir);

        try {
          const result = mergeResults(sessionDirs.map((sessionsDir) => indexAllSessions(dbManager, sessionsDir)));
          const stats = getSessionStats(dbManager);

          let output = `\n✅ Session indexing complete!\n\n`;
          output += `📊 Results:\n`;
          output += `├─ Sessions processed: ${result.sessionsProcessed}\n`;
          output += `├─ Sessions indexed: ${result.sessionsIndexed}\n`;
          output += `├─ Sessions skipped (already indexed): ${result.sessionsSkipped}\n`;
          output += `└─ Messages indexed: ${result.messagesIndexed}\n`;

          if (stats.projects.length > 0) {
            output += `\n📁 Projects indexed:\n`;
            for (const project of stats.projects) {
              output += `├─ ${project.project}: ${project.sessions} sessions, ${project.messages} messages\n`;
            }
          }

          output += `\n📈 Database totals:\n`;
          output += `├─ ${stats.totalSessions} sessions\n`;
          output += `├─ ${stats.totalMessages} messages\n`;
          output += `└─ ${stats.projects.length} projects\n`;

          if (result.errors.length > 0) {
            output += `\n⚠️ Errors (${result.errors.length}):\n`;
            for (const err of result.errors.slice(0, 3)) {
              output += `├─ ${err}\n`;
            }
            if (result.errors.length > 3) {
              output += `└─ ... and ${result.errors.length - 3} more\n`;
            }
          }

          output += `\n💡 Use the session_search tool to search across indexed sessions.`;
          ctx.ui.notify(output, 'info');
        } finally {
          dbManager.close();
        }
      } catch (err) {
        ctx.ui.notify(`❌ Session indexing failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    },
  });
}
