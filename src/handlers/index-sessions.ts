/**
 * Index sessions command — /memory-index-sessions imports past sessions into SQLite.
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { DatabaseManager } from '../store/db.js';
import { indexAllSessions, getSessionStats } from '../store/session-indexer.js';

interface IndexSessionsCommandOptions {
  sessionsDir?: string;
}

const DEFAULT_SESSIONS_DIR = path.join(os.homedir(), '.pi', 'agent', 'sessions');

export function registerIndexSessionsCommand(
  pi: ExtensionAPI,
  dbManager: DatabaseManager,
  options: IndexSessionsCommandOptions = {},
): void {
  pi.registerCommand("memory-index-sessions", {
    description: "Import past Pi sessions into the search database",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      // Show initial progress
      ctx.ui.notify('🔍 Scanning session directories...', 'info');

      try {
        // Count sessions first for progress display
        let totalFiles = 0;
        let projectDirs: string[] = [];
        const sessionsDir = options.sessionsDir ?? DEFAULT_SESSIONS_DIR;

        if (fs.existsSync(sessionsDir)) {
          projectDirs = fs.readdirSync(sessionsDir)
            .filter(d => fs.statSync(path.join(sessionsDir, d)).isDirectory());
          for (const dir of projectDirs) {
            const files = fs.readdirSync(path.join(sessionsDir, dir))
              .filter(f => f.endsWith('.jsonl'));
            totalFiles += files.length;
          }
        }

        ctx.ui.notify(`📁 Found ${totalFiles} session files across ${projectDirs.length} projects\n⏳ Indexing...`, 'info');

        const result = indexAllSessions(dbManager, sessionsDir);
        const stats = getSessionStats(dbManager);

          let output = `\n✅ Session indexing complete!\n\n`;
          output += `📊 Results:\n`;
          output += `├─ Sessions processed: ${result.sessionsProcessed}\n`;
          output += `├─ Sessions indexed: ${result.sessionsIndexed}\n`;
          output += `├─ Sessions skipped (already indexed): ${result.sessionsSkipped}\n`;
          output += `└─ Messages indexed: ${result.messagesIndexed}\n`;

          if (stats.projects.length > 0) {
            output += `\n📁 Projects indexed:\n`;
            for (const p of stats.projects) {
              output += `├─ ${p.project}: ${p.sessions} sessions, ${p.messages} messages\n`;
            }
          }

          // Show totals
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
      } catch (err) {
        ctx.ui.notify(`❌ Session indexing failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    },
  });
}
