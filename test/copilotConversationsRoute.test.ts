// test/copilotConversationsRoute.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { seedSession } from './helpers/testSession';
import { copilotConversationService } from '@/lib/services/CopilotConversationService';
import { copilotMessageService } from '@/lib/services/CopilotMessageService';
import { GET as listConversations } from '@/app/api/copilot/conversations/route';
import { GET as getConversation } from '@/app/api/copilot/conversations/[id]/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-copilotconvoroute-'));
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

function req(cookieHeader?: string): NextRequest {
  return new NextRequest('http://localhost/api/copilot/conversations', {
    headers: cookieHeader ? { Cookie: cookieHeader } : {},
  });
}

describe('copilot conversation routes', () => {
  it('GET /api/copilot/conversations requires login', async () => {
    const res = await listConversations(req());
    expect(res.status).toBe(401);
  });

  it('GET /api/copilot/conversations lists only the requesting user\'s conversations', async () => {
    const { userId, cookieHeader } = await seedSession('Alice');
    const { userId: otherUserId } = await seedSession('Bob');
    await copilotConversationService.create({ title: 'Mine', createdBy: userId });
    await copilotConversationService.create({ title: 'Not mine', createdBy: otherUserId });

    const res = await listConversations(req(cookieHeader));
    const body = await res.json();
    expect(body.data.map((c: any) => c.title)).toEqual(['Mine']);
  });

  it('GET /api/copilot/conversations/[id] returns 404 for an unknown id', async () => {
    const { cookieHeader } = await seedSession();
    const res = await getConversation(req(cookieHeader), { params: Promise.resolve({ id: 'does-not-exist' }) });
    expect(res.status).toBe(404);
  });

  it('GET /api/copilot/conversations/[id] returns 403 for another user\'s conversation', async () => {
    const { userId: ownerId } = await seedSession('Alice');
    const { cookieHeader: otherCookie } = await seedSession('Bob');
    const convo = await copilotConversationService.create({ title: 'Alice only', createdBy: ownerId });

    const res = await getConversation(req(otherCookie), { params: Promise.resolve({ id: convo.id }) });
    expect(res.status).toBe(403);
  });

  it('GET /api/copilot/conversations/[id] returns the conversation with its messages in order', async () => {
    const { userId, cookieHeader } = await seedSession();
    const convo = await copilotConversationService.create({ title: 'How do themes work?', createdBy: userId });
    await copilotMessageService.append({ conversationId: convo.id, role: 'user', content: 'How do themes work?' });
    await copilotMessageService.append({
      conversationId: convo.id,
      role: 'assistant',
      content: 'Generate a theme from the Themes page.',
      toolCall: { name: 'navigate_to_page', input: { path: '/dashboard/themes' } },
      provider: 'claude',
      model: 'claude-sonnet-5',
    });

    const res = await getConversation(req(cookieHeader), { params: Promise.resolve({ id: convo.id }) });
    const body = await res.json();
    expect(body.data.title).toBe('How do themes work?');
    expect(body.data.messages.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect(body.data.messages[1].toolCall).toEqual({ name: 'navigate_to_page', input: { path: '/dashboard/themes' } });
  });
});
