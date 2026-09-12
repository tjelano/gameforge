import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { jobService } from '@/lib/services/JobService';
import { sessionService } from '@/lib/services/SessionService';
import { combineComponentHtml, parseComponentHtml, type ComponentTokens } from '@/lib/services/ComponentGenerator';
import { PATCH } from '@/app/api/jobs/[id]/component/route';
import { POST } from '@/app/api/jobs/[id]/component/reset/route';

let tempRoot: string;
let cookieHeader: string;

const ORIGINAL: ComponentTokens = {
  html: '<button class="btn-primary">Buy now</button>',
  css: '.btn-primary { background: var(--color-accent); }',
};
const EDITED: ComponentTokens = { ...ORIGINAL, html: '<button class="btn-primary">Buy today</button>' };

async function makeCompleteComponentJob(): Promise<{ jobId: string; filename: string }> {
  const style = await styleService.create({ name: 'x', createdBy: '11111111-1111-1111-1111-111111111111', parameters: '{}' });
  const filename = `component-${crypto.randomUUID()}.html`;
  await fsPromises.writeFile(path.join(tempRoot, 'storage', 'components', filename), combineComponentHtml(ORIGINAL));
  const job = await jobService.create({ styleId: style.id, createdBy: '11111111-1111-1111-1111-111111111111', assetType: 'component', prompt: 'x', outputKind: 'component' });
  DatabaseConnection.getInstance()
    .prepare("UPDATE jobs SET status = 'complete', result_path = ? WHERE id = ?")
    .run(filename, job.id);
  return { jobId: job.id, filename };
}

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-jobcomponentreset-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'components'), { recursive: true });
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  DatabaseConnection.getInstance()
    .prepare('INSERT INTO users (id, name, is_admin, created_at) VALUES (?, ?, ?, ?)')
    .run('11111111-1111-1111-1111-111111111111', 'Test User', 0, Date.now());
  const { token } = await sessionService.create('11111111-1111-1111-1111-111111111111');
  cookieHeader = `session=${token}`;
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

function patchRequest(tokens: ComponentTokens): NextRequest {
  return new NextRequest('http://localhost/x', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    body: JSON.stringify(tokens),
  });
}

function resetRequest(): NextRequest {
  return new NextRequest('http://localhost/x', { method: 'POST', headers: { Cookie: cookieHeader } });
}

describe('POST /api/jobs/[id]/component/reset', () => {
  it('restores the file to the original tokens after an edit', async () => {
    const { jobId, filename } = await makeCompleteComponentJob();
    await PATCH(patchRequest(EDITED), { params: Promise.resolve({ id: jobId }) });

    const res = await POST(resetRequest(), { params: Promise.resolve({ id: jobId }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toEqual(ORIGINAL);

    const document = await fsPromises.readFile(path.join(tempRoot, 'storage', 'components', filename), 'utf-8');
    expect(parseComponentHtml(document)).toEqual(ORIGINAL);
  });

  it('returns 404 when the job has never been edited', async () => {
    const { jobId } = await makeCompleteComponentJob();
    const res = await POST(resetRequest(), { params: Promise.resolve({ id: jobId }) });
    expect(res.status).toBe(404);
  });

  it('rejects with 409 when the job has been promoted', async () => {
    const { jobId } = await makeCompleteComponentJob();
    await PATCH(patchRequest(EDITED), { params: Promise.resolve({ id: jobId }) });
    DatabaseConnection.getInstance().prepare("UPDATE jobs SET status = 'promoted' WHERE id = ?").run(jobId);
    const res = await POST(resetRequest(), { params: Promise.resolve({ id: jobId }) });
    expect(res.status).toBe(409);
  });

  it('returns 404 for a nonexistent job', async () => {
    const res = await POST(resetRequest(), { params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' }) });
    expect(res.status).toBe(404);
  });

  it('returns 400 instead of writing unsanitized content when the captured originalComponent no longer passes sanitization', async () => {
    const { jobId, filename } = await makeCompleteComponentJob();
    // Simulate an "already captured, now-invalid" originalComponent — the
    // normal PATCH flow always sanitizes before capturing, so the only way
    // to get one of these into the DB is to write it directly, the way an
    // older build (or a direct DB edit) might have.
    const unsanitized: ComponentTokens = { html: '<button>x</button>', css: 'body { background: url(evil.png); }' };
    DatabaseConnection.getInstance()
      .prepare('UPDATE jobs SET options = ? WHERE id = ?')
      .run(JSON.stringify({ originalComponent: unsanitized }), jobId);

    const before = await fsPromises.readFile(path.join(tempRoot, 'storage', 'components', filename), 'utf-8');

    const res = await POST(resetRequest(), { params: Promise.resolve({ id: jobId }) });
    expect(res.status).toBe(400);

    const after = await fsPromises.readFile(path.join(tempRoot, 'storage', 'components', filename), 'utf-8');
    expect(after).toEqual(before);
  });

  it('returns a clean 400 (not 500) when originalComponent is shape-invalid', async () => {
    const { jobId, filename } = await makeCompleteComponentJob();
    // Only reachable via a corrupted DB row — normal PATCH/reset flow only
    // ever writes originalComponent after Zod validation + sanitization.
    DatabaseConnection.getInstance()
      .prepare('UPDATE jobs SET options = ? WHERE id = ?')
      .run(JSON.stringify({ originalComponent: { html: '<button>x</button>' } }), jobId);

    const before = await fsPromises.readFile(path.join(tempRoot, 'storage', 'components', filename), 'utf-8');

    const res = await POST(resetRequest(), { params: Promise.resolve({ id: jobId }) });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe('string');
    expect(body.error).not.toMatch(/\[|Zod/); // no raw issues-array dump

    const after = await fsPromises.readFile(path.join(tempRoot, 'storage', 'components', filename), 'utf-8');
    expect(after).toEqual(before);
  });
});
