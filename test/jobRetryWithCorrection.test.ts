import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { seedSession } from '@/test/helpers/testSession';
import { OLLAMA_NO_TOOL_CALL_ERROR_PREFIX } from '@/lib/services/ollamaToolCall';

let tempRoot: string;
let userId: string;
let cookieHeader: string;
const STYLE_ID = '11111111-1111-1111-1111-111111111111';

function insertJob(id: string, status: string, errorMessage: string | null, options: Record<string, unknown>) {
  const db = DatabaseConnection.getInstance();
  db.prepare(`
    INSERT INTO jobs (id, style_id, created_by, asset_type, prompt, output_kind, status, error_message, options, created_at, updated_at)
    VALUES (?, ?, ?, 'theme', 'warm', 'theme', ?, ?, ?, 1000, 1000)
  `).run(id, STYLE_ID, userId, status, errorMessage, JSON.stringify(options));
}

function req(jobId: string): NextRequest {
  return new NextRequest('http://localhost/api/jobs/retry-with-correction', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    body: JSON.stringify({ jobId }),
  });
}

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-retrycorrection-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'gameforge-test' }));
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  const db = DatabaseConnection.getInstance();
  db.prepare(`INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at) VALUES (?, 'style', 'someone', '{}', 0, 1000, 1000)`).run(STYLE_ID);
  ({ userId, cookieHeader } = await seedSession());
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

// The route's jobId schema is z.string().uuid() (consistent with the sibling
// /api/jobs/retry/route.ts, and with real job ids which come from
// crypto.randomUUID() in JobService.create) -- so test job ids must be
// UUID-shaped, not plain literals like "job-1", or Zod rejects them with a
// 400 before the handler's own business logic ever runs.
const JOB_1 = '00000000-0000-0000-0000-000000000001';
const JOB_2 = '00000000-0000-0000-0000-000000000002';
const JOB_3 = '00000000-0000-0000-0000-000000000003';
const JOB_4 = '00000000-0000-0000-0000-000000000004';

describe('POST /api/jobs/retry-with-correction', () => {
  it('401s when not logged in', async () => {
    insertJob(JOB_1, 'failed', OLLAMA_NO_TOOL_CALL_ERROR_PREFIX, { provider: 'ollama' });
    const { POST } = await import('@/app/api/jobs/retry-with-correction/route');
    const res = await POST(new NextRequest('http://localhost/api/jobs/retry-with-correction', { method: 'POST', body: JSON.stringify({ jobId: JOB_1 }) }));
    expect(res.status).toBe(401);
  });

  it('rejects a job that did not fail with the ollama-no-tool-call error', async () => {
    insertJob(JOB_2, 'failed', 'some other network error', { provider: 'ollama' });
    const { POST } = await import('@/app/api/jobs/retry-with-correction/route');
    const res = await POST(req(JOB_2));
    expect(res.status).toBe(400);
  });

  it('rejects a job that is not failed', async () => {
    insertJob(JOB_3, 'complete', null, { provider: 'ollama' });
    const { POST } = await import('@/app/api/jobs/retry-with-correction/route');
    const res = await POST(req(JOB_3));
    expect(res.status).toBe(409);
  });

  it('resets the job to pending with ollamaCorrectionRequested set, preserving the rest of options', async () => {
    insertJob(JOB_4, 'failed', `${OLLAMA_NO_TOOL_CALL_ERROR_PREFIX} for emit_theme`, { provider: 'ollama', model: 'llama3-groq-tool-use:8b', ollamaHost: 'http://localhost:11434' });
    const { POST } = await import('@/app/api/jobs/retry-with-correction/route');
    const res = await POST(req(JOB_4));
    expect(res.status).toBe(200);

    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(JOB_4) as any;
    expect(row.status).toBe('pending');
    expect(row.error_message).toBeNull();
    const options = JSON.parse(row.options);
    expect(options.ollamaCorrectionRequested).toBe(true);
    expect(options.model).toBe('llama3-groq-tool-use:8b'); // unrelated fields preserved
  });
});
