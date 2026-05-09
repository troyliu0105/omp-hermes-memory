import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseManager } from '../../src/store/db.js';
import { registerIndexSessionsCommand } from '../../src/handlers/index-sessions.js';
import { getSessionStats } from '../../src/store/session-indexer.js';

function setupMockPi() {
  const handlers = new Map<string, Function>();
  const pi = {
    registerCommand: (name: string, opts: { handler: Function }) => handlers.set(name, opts.handler),
  } as any;
  return { pi, handlers };
}

describe('index-sessions command', () => {
  let tmpDir: string;
  let sessionsDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'index-sessions-handler-'));
    sessionsDir = path.join(tmpDir, 'sessions');
    dbManager = new DatabaseManager(path.join(tmpDir, 'memory-a'));
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('indexes sessions into the provided db manager', async () => {
    const projectDir = path.join(sessionsDir, '--tmp-project-a--');
    fs.mkdirSync(projectDir, { recursive: true });

    const lines = [
      JSON.stringify({ type: 'session', id: 's1', timestamp: '2026-05-03T00:00:00Z', cwd: '/tmp/project-a' }),
      JSON.stringify({
        type: 'message',
        id: 'm1',
        parentId: null,
        timestamp: '2026-05-03T00:01:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Hello' }], timestamp: Date.now() },
      }),
    ];
    fs.writeFileSync(path.join(projectDir, 'session1.jsonl'), lines.join('\n'));

    const { pi, handlers } = setupMockPi();
    registerIndexSessionsCommand(pi, dbManager, { sessionsDir });

    const notifications: string[] = [];
    const ctx = { ui: { notify: (message: string) => notifications.push(message) } } as any;
    await handlers.get('memory-index-sessions')('', ctx);

    const stats = getSessionStats(dbManager);
    assert.equal(stats.totalSessions, 1);
    assert.equal(stats.totalMessages, 1);
    assert.ok(notifications.some((message) => message.includes('Session indexing complete')));
  });

  it('handles empty sessions directory gracefully', async () => {
    fs.mkdirSync(sessionsDir, { recursive: true });

    const { pi, handlers } = setupMockPi();
    registerIndexSessionsCommand(pi, dbManager, { sessionsDir });

    const notifications: string[] = [];
    const ctx = { ui: { notify: (message: string) => notifications.push(message) } } as any;
    await handlers.get('memory-index-sessions')('', ctx);

    const stats = getSessionStats(dbManager);
    assert.equal(stats.totalSessions, 0);
    assert.ok(notifications.some((message) => message.includes('Found 0 session files')));
  });
});
