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

let tempRoot: string;
let cookieHeader: string;

const ORIGINAL: ComponentTokens = {
  html: '<button class="btn-primary">Buy now</button>',
  css: '.btn-primary { background: var(--color-accent); }',
};
const EDITED: ComponentTokens = {
  html: '<button class="btn-primary">Buy today</button>',
  css: '.btn-primary { background: var(--color-accent); color: var(--color-bg); }',
};

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
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-jobcomponentedit-'));
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

describe('PATCH /api/jobs/[id]/component', () => {
  it('persists a valid edit and returns the sanitized tokens', async () => {
    const { jobId, filename } = await makeCompleteComponentJob();
    const res = await PATCH(patchRequest(EDITED), { params: Promise.resolve({ id: jobId }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toEqual(EDITED);
    const document = await fsPromises.readFile(path.join(tempRoot, 'storage', 'components', filename), 'utf-8');
    expect(parseComponentHtml(document)).toEqual(EDITED);
  });

  it('captures the original tokens into jobs.options.originalComponent on the first edit only', async () => {
    const { jobId } = await makeCompleteComponentJob();
    await PATCH(patchRequest(EDITED), { params: Promise.resolve({ id: jobId }) });
    const jobAfterFirst = await jobService.getById(jobId);
    expect(JSON.parse(jobAfterFirst!.options).originalComponent).toEqual(ORIGINAL);

    const SECOND_EDIT = { ...EDITED, html: '<button class="btn-primary">Buy tomorrow</button>' };
    await PATCH(patchRequest(SECOND_EDIT), { params: Promise.resolve({ id: jobId }) });
    const jobAfterSecond = await jobService.getById(jobId);
    expect(JSON.parse(jobAfterSecond!.options).originalComponent).toEqual(ORIGINAL);
  });

  it('rejects CSS containing url( with 400 and does not touch the file', async () => {
    const { jobId, filename } = await makeCompleteComponentJob();
    const invalid = { ...EDITED, css: '.btn { background: url(https://evil.example/x.png); }' };
    const res = await PATCH(patchRequest(invalid), { params: Promise.resolve({ id: jobId }) });
    expect(res.status).toBe(400);
    const document = await fsPromises.readFile(path.join(tempRoot, 'storage', 'components', filename), 'utf-8');
    expect(parseComponentHtml(document)).toEqual(ORIGINAL);
  });

  it('sanitizes a <script> tag out of the html rather than rejecting the whole request', async () => {
    const { jobId } = await makeCompleteComponentJob();
    const withScript = { ...EDITED, html: '<button>ok</button><script>alert(1)</script>' };
    const res = await PATCH(patchRequest(withScript), { params: Promise.resolve({ id: jobId }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.html).not.toContain('<script');
  });

  it('rejects with 409 when the job is not in complete status', async () => {
    const style = await styleService.create({ name: 'x', createdBy: '11111111-1111-1111-1111-111111111111', parameters: '{}' });
    const job = await jobService.create({ styleId: style.id, createdBy: '11111111-1111-1111-1111-111111111111', assetType: 'component', prompt: 'x', outputKind: 'component' });
    const res = await PATCH(patchRequest(EDITED), { params: Promise.resolve({ id: job.id }) });
    expect(res.status).toBe(409);
  });

  it('rejects with 400 when the job is not a component job', async () => {
    const style = await styleService.create({ name: 'x', createdBy: '11111111-1111-1111-1111-111111111111', parameters: '{}' });
    const job = await jobService.create({ styleId: style.id, createdBy: '11111111-1111-1111-1111-111111111111', assetType: 'sprite', prompt: 'x', outputKind: 'image' });
    DatabaseConnection.getInstance().prepare("UPDATE jobs SET status = 'complete', result_path = 'x.png' WHERE id = ?").run(job.id);
    const res = await PATCH(patchRequest(EDITED), { params: Promise.resolve({ id: job.id }) });
    expect(res.status).toBe(400);
  });

  it('returns 404 for a nonexistent job', async () => {
    const res = await PATCH(patchRequest(EDITED), { params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' }) });
    expect(res.status).toBe(404);
  });
});
