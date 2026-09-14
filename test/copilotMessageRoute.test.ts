// test/copilotMessageRoute.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { seedSession } from './helpers/testSession';
import { copilotConversationService } from '@/lib/services/CopilotConversationService';
import { copilotMessageService } from '@/lib/services/CopilotMessageService';
import { POST as sendMessage } from '@/app/api/copilot/message/route';
import { GET as getConversation } from '@/app/api/copilot/conversations/[id]/route';

let tempRoot: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(async () => {
  originalEnv = { ...process.env };
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-copilotmsgroute-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  await fsPromises.mkdir(path.join(tempRoot, 'docs'), { recursive: true });
  await fsPromises.writeFile(path.join(tempRoot, 'docs', 'copilot-knowledge.md'), '# Test knowledge doc');
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
});

afterEach(async () => {
  process.env = originalEnv;
  vi.unstubAllGlobals();
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

function req(body: unknown, cookieHeader?: string): NextRequest {
  return new NextRequest('http://localhost/api/copilot/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
    body: JSON.stringify(body),
  });
}

function getReq(cookieHeader?: string): NextRequest {
  return new NextRequest('http://localhost/api/copilot/conversations/x', {
    headers: cookieHeader ? { Cookie: cookieHeader } : {},
  });
}

describe('POST /api/copilot/message', () => {
  it('requires login', async () => {
    const res = await sendMessage(req({ text: 'hi' }));
    expect(res.status).toBe(401);
  });

  it('returns 503 with a clear message when Claude is selected but no key is configured, and persists nothing', async () => {
    delete process.env.THEME_API_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CHEAPERINFERENCE_API_KEY;
    const { userId, cookieHeader } = await seedSession();

    const res = await sendMessage(req({ text: 'How do themes work?' }, cookieHeader));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/isn't configured/);

    // A misconfigured provider must not leave an orphaned conversation or a
    // dangling user message behind -- there's no delete feature to clean it
    // up, so a failed call has to leave no trace at all.
    const conversations = await copilotConversationService.listForUser(userId);
    expect(conversations).toHaveLength(0);
  });

  it('creates a new conversation, calls Claude, and persists both sides of the turn', async () => {
    process.env.ANTHROPIC_API_KEY = 'fake-key';
    delete process.env.THEME_API_PROVIDER;
    const { userId, cookieHeader } = await seedSession();

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'Generate a theme from the Themes page.' }],
      stop_reason: 'end_turn',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await sendMessage(req({ text: 'How do themes work?' }, cookieHeader));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.reply.text).toBe('Generate a theme from the Themes page.');
    expect(body.data.reply.toolCall).toBeUndefined();
    expect(body.data.conversationId).toBeTruthy();

    const conversations = await copilotConversationService.listForUser(userId);
    expect(conversations).toHaveLength(1);
    expect(conversations[0].title).toBe('How do themes work?');
  });

  it('calls Ollama when provider/model/ollamaHost are given, and navigates via a returned tool call', async () => {
    const { cookieHeader } = await seedSession();

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      message: {
        content: "Here's the Ollama settings page.",
        tool_calls: [{ function: { name: 'navigate_to_page', arguments: { path: '/dashboard/settings/ollama' } } }],
      },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await sendMessage(req({
      text: 'Take me to the Ollama settings',
      provider: 'ollama',
      model: 'llama3-groq-tool-use:8b',
      ollamaHost: 'http://localhost:11434',
    }, cookieHeader));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.reply.toolCall).toEqual({ name: 'navigate_to_page', input: { path: '/dashboard/settings/ollama' } });
  });

  it('rejects provider "ollama" without model/ollamaHost with a 400', async () => {
    const { cookieHeader } = await seedSession();
    const res = await sendMessage(req({ text: 'hi', provider: 'ollama' }, cookieHeader));
    expect(res.status).toBe(400);
  });

  it('drops a tool call whose path is outside the enum, but still returns the text reply', async () => {
    const { cookieHeader } = await seedSession();

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      message: {
        content: 'Sure, heading there now.',
        tool_calls: [{ function: { name: 'navigate_to_page', arguments: { path: '/dashboard/jobs/123/edit' } } }],
      },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await sendMessage(req({
      text: 'Take me to job 123',
      provider: 'ollama',
      model: 'llama3-groq-tool-use:8b',
      ollamaHost: 'http://localhost:11434',
    }, cookieHeader));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.reply.text).toBe('Sure, heading there now.');
    expect(body.data.reply.toolCall).toBeUndefined();
  });

  it('returns 403 when posting to another user\'s conversationId', async () => {
    const { userId: ownerId } = await seedSession('Alice');
    const { cookieHeader: otherCookie } = await seedSession('Bob');
    const convo = await copilotConversationService.create({ title: 'Alice only', createdBy: ownerId });

    const res = await sendMessage(req({ conversationId: convo.id, text: 'hi' }, otherCookie));
    expect(res.status).toBe(403);
  });

  it('returns 404 when posting to an unknown conversationId', async () => {
    const { cookieHeader } = await seedSession();
    const res = await sendMessage(req({ conversationId: '99999999-9999-9999-9999-999999999999', text: 'hi' }, cookieHeader));
    expect(res.status).toBe(404);
  });

  it('leaves no dangling user message in an existing conversation when a mid-conversation Ollama call fails', async () => {
    const { userId, cookieHeader } = await seedSession();
    const convo = await copilotConversationService.create({ title: 'Existing', createdBy: userId });
    await copilotMessageService.append({ conversationId: convo.id, role: 'user', content: 'first question' });
    await copilotMessageService.append({ conversationId: convo.id, role: 'assistant', content: 'first answer' });

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: 'model not found' }), { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await sendMessage(req({
      conversationId: convo.id,
      text: 'second question',
      provider: 'ollama',
      model: 'llama3-groq-tool-use:8b',
      ollamaHost: 'http://localhost:11434',
    }, cookieHeader));
    expect(res.status).toBe(502);

    // A failed provider call must not leave the new, unanswered user message
    // behind -- a retry would otherwise replay it on every attempt.
    const messages = await copilotMessageService.listByConversation(convo.id);
    expect(messages).toHaveLength(2);
    expect(messages.map(m => m.content)).toEqual(['first question', 'first answer']);
  });

  it('round-trips a persisted tool call as an object through GET /api/copilot/conversations/[id]', async () => {
    const { cookieHeader } = await seedSession();

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      message: {
        content: "Here's the Ollama settings page.",
        tool_calls: [{ function: { name: 'navigate_to_page', arguments: { path: '/dashboard/settings/ollama' } } }],
      },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const postRes = await sendMessage(req({
      text: 'Take me to the Ollama settings',
      provider: 'ollama',
      model: 'llama3-groq-tool-use:8b',
      ollamaHost: 'http://localhost:11434',
    }, cookieHeader));
    expect(postRes.status).toBe(200);
    const postBody = await postRes.json();
    const { conversationId } = postBody.data;
    expect(conversationId).toBeTruthy();

    const getRes = await getConversation(getReq(cookieHeader), { params: Promise.resolve({ id: conversationId }) });
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    const assistantMessage = getBody.data.messages.find((m: any) => m.role === 'assistant');
    expect(assistantMessage.toolCall).toEqual({ name: 'navigate_to_page', input: { path: '/dashboard/settings/ollama' } });
  });
});
