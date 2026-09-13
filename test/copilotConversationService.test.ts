import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { copilotConversationService } from '@/lib/services/CopilotConversationService';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-copilotconvo-'));
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

describe('CopilotConversationService', () => {
  it('creates a conversation and reads it back', async () => {
    const convo = await copilotConversationService.create({ title: 'How do themes work?', createdBy: 'user-1' });
    expect(convo.title).toBe('How do themes work?');
    expect(convo.created_by).toBe('user-1');

    const fetched = await copilotConversationService.getById(convo.id);
    expect(fetched?.id).toBe(convo.id);
  });

  it('getById returns null for an unknown id', async () => {
    expect(await copilotConversationService.getById('does-not-exist')).toBeNull();
  });

  it('listForUser scopes to the creator and orders newest-updated first', async () => {
    const a = await copilotConversationService.create({ title: 'A', createdBy: 'user-1' });
    const b = await copilotConversationService.create({ title: 'B', createdBy: 'user-1' });
    await copilotConversationService.create({ title: 'Other user', createdBy: 'user-2' });

    // touch()'s updated_at must land strictly after b's own created_at/updated_at
    // for the assertion below to be meaningful -- without this gap, a fast
    // synchronous run could tie all three Date.now() calls to the same
    // millisecond, making the expected order a coincidence rather than a
    // real assertion of touch()'s effect.
    await new Promise(resolve => setTimeout(resolve, 20));
    await copilotConversationService.touch(a.id);

    const list = await copilotConversationService.listForUser('user-1');
    expect(list.map(c => c.id)).toEqual([a.id, b.id]);
  });

  it('touch bumps updated_at', async () => {
    const convo = await copilotConversationService.create({ title: 'A', createdBy: 'user-1' });
    const before = convo.updated_at;
    await new Promise(resolve => setTimeout(resolve, 20)); // comfortably above typical Date.now() clock-tick resolution
    await copilotConversationService.touch(convo.id);
    const after = await copilotConversationService.getById(convo.id);
    expect(after!.updated_at).toBeGreaterThan(before);
  });
});
