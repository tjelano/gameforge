import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-migration016-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('migration 016', () => {
  it('creates copilot_conversations and copilot_messages with working constraints', () => {
    const db = DatabaseConnection.getInstance();

    db.prepare(`
      INSERT INTO copilot_conversations (id, title, created_by, created_at, updated_at)
      VALUES ('11111111-1111-1111-1111-111111111111', 'How do themes work?', 'user-1', 1000, 1000)
    `).run();

    db.prepare(`
      INSERT INTO copilot_messages (id, conversation_id, role, content, tool_call, provider, model, created_at)
      VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'user', 'How do themes work?', NULL, NULL, NULL, 1000)
    `).run();

    const convo = db.prepare('SELECT * FROM copilot_conversations WHERE id = ?').get('11111111-1111-1111-1111-111111111111') as any;
    expect(convo.title).toBe('How do themes work?');

    const msg = db.prepare('SELECT * FROM copilot_messages WHERE id = ?').get('22222222-2222-2222-2222-222222222222') as any;
    expect(msg.role).toBe('user');

    expect(() => db.prepare(`
      INSERT INTO copilot_messages (id, conversation_id, role, content, created_at)
      VALUES ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'system', 'nope', 1000)
    `).run()).toThrow(/CHECK constraint/);

    expect(() => db.prepare(`
      INSERT INTO copilot_messages (id, conversation_id, role, content, created_at)
      VALUES ('44444444-4444-4444-4444-444444444444', 'does-not-exist', 'user', 'orphan', 1000)
    `).run()).toThrow(/FOREIGN KEY constraint/);
  });
});
