import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { copilotConversationService } from '@/lib/services/CopilotConversationService';
import { copilotMessageService } from '@/lib/services/CopilotMessageService';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-copilotmsg-'));
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

describe('CopilotMessageService', () => {
  it('appends a plain user message with null tool_call/provider/model', async () => {
    const convo = await copilotConversationService.create({ title: 'x', createdBy: 'user-1' });
    const msg = await copilotMessageService.append({ conversationId: convo.id, role: 'user', content: 'How do themes work?' });
    expect(msg.role).toBe('user');
    expect(msg.tool_call).toBeNull();
    expect(msg.provider).toBeNull();
    expect(msg.model).toBeNull();
  });

  it('appends an assistant message with a JSON-serialized tool_call, provider, and model', async () => {
    const convo = await copilotConversationService.create({ title: 'x', createdBy: 'user-1' });
    const msg = await copilotMessageService.append({
      conversationId: convo.id,
      role: 'assistant',
      content: "Here's the Ollama settings page.",
      toolCall: { name: 'navigate_to_page', input: { path: '/dashboard/settings/ollama' } },
      provider: 'claude',
      model: 'claude-sonnet-5',
    });
    expect(JSON.parse(msg.tool_call!)).toEqual({ name: 'navigate_to_page', input: { path: '/dashboard/settings/ollama' } });
    expect(msg.provider).toBe('claude');
    expect(msg.model).toBe('claude-sonnet-5');
  });

  it('listByConversation returns messages oldest-first, scoped to one conversation', async () => {
    const a = await copilotConversationService.create({ title: 'A', createdBy: 'user-1' });
    const b = await copilotConversationService.create({ title: 'B', createdBy: 'user-1' });
    const first = await copilotMessageService.append({ conversationId: a.id, role: 'user', content: 'first' });
    const second = await copilotMessageService.append({ conversationId: a.id, role: 'assistant', content: 'second' });
    await copilotMessageService.append({ conversationId: b.id, role: 'user', content: 'other conversation' });

    const messages = await copilotMessageService.listByConversation(a.id);
    expect(messages.map(m => m.id)).toEqual([first.id, second.id]);
  });
});
