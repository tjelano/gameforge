import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { jobService } from '@/lib/services/JobService';
import { tokensToCss, parseThemeCss, type ThemeTokens } from '@/lib/services/ThemeGenerator';
import { PATCH } from '@/app/api/jobs/[id]/theme/route';

let tempRoot: string;

const ORIGINAL: ThemeTokens = {
  colorBackground: '#1c1a17', colorForeground: '#ede7dc', colorAccent: '#e8a33d', colorBorder: '#3c352a',
  fontHeading: "'Cinzel', serif", fontBody: "'EB Garamond', serif", spaceUnit: '8px', radiusBase: '4px',
};
const EDITED: ThemeTokens = { ...ORIGINAL, colorAccent: '#2c7be5', spaceUnit: '10px' };

async function makeCompleteThemeJob(): Promise<{ jobId: string; filename: string }> {
  const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
  const filename = `job-${crypto.randomUUID()}.css`;
  await fsPromises.writeFile(path.join(tempRoot, 'storage', 'themes', filename), tokensToCss(ORIGINAL));
  const job = await jobService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x', outputKind: 'theme' });
  DatabaseConnection.getInstance()
    .prepare("UPDATE jobs SET status = 'complete', result_path = ? WHERE id = ?")
    .run(filename, job.id);
  return { jobId: job.id, filename };
}

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-jobthemeedit-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'themes'), { recursive: true });
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

function patchRequest(tokens: ThemeTokens): NextRequest {
  return new NextRequest('http://localhost/api/jobs/x/theme', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tokens),
  });
}

describe('PATCH /api/jobs/[id]/theme', () => {
  it('persists a valid edit to the job\'s CSS file and returns the new tokens', async () => {
    const { jobId, filename } = await makeCompleteThemeJob();
    const res = await PATCH(patchRequest(EDITED), { params: Promise.resolve({ id: jobId }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual(EDITED);

    const css = await fsPromises.readFile(path.join(tempRoot, 'storage', 'themes', filename), 'utf-8');
    expect(parseThemeCss(css)).toEqual(EDITED);
  });

  it('captures the original tokens into jobs.options on the first edit only', async () => {
    const { jobId } = await makeCompleteThemeJob();
    await PATCH(patchRequest(EDITED), { params: Promise.resolve({ id: jobId }) });

    const jobAfterFirst = await jobService.getById(jobId);
    expect(JSON.parse(jobAfterFirst!.options).originalTokens).toEqual(ORIGINAL);

    // A second edit must not overwrite the already-captured original.
    const SECOND_EDIT = { ...EDITED, colorBackground: '#000000' };
    await PATCH(patchRequest(SECOND_EDIT), { params: Promise.resolve({ id: jobId }) });
    const jobAfterSecond = await jobService.getById(jobId);
    expect(JSON.parse(jobAfterSecond!.options).originalTokens).toEqual(ORIGINAL);
  });

  it('bumps updated_at on a second edit, not just the first', async () => {
    const { jobId } = await makeCompleteThemeJob();
    await PATCH(patchRequest(EDITED), { params: Promise.resolve({ id: jobId }) });
    const afterFirst = await jobService.getById(jobId);

    // Force updated_at backwards so a second bump is unambiguously detectable
    // regardless of how fast the two PATCH calls run.
    const past = afterFirst!.updated_at - 10_000;
    DatabaseConnection.getInstance().prepare('UPDATE jobs SET updated_at = ? WHERE id = ?').run(past, jobId);

    const SECOND_EDIT = { ...EDITED, colorBackground: '#000000' };
    await PATCH(patchRequest(SECOND_EDIT), { params: Promise.resolve({ id: jobId }) });
    const afterSecond = await jobService.getById(jobId);

    expect(afterSecond!.updated_at).toBeGreaterThan(past);
  });

  it('rejects an invalid token value with 400 and does not touch the file', async () => {
    const { jobId, filename } = await makeCompleteThemeJob();
    const invalid = { ...EDITED, colorAccent: 'javascript:alert(1)' };
    const res = await PATCH(patchRequest(invalid as ThemeTokens), { params: Promise.resolve({ id: jobId }) });
    expect(res.status).toBe(400);

    const css = await fsPromises.readFile(path.join(tempRoot, 'storage', 'themes', filename), 'utf-8');
    expect(parseThemeCss(css)).toEqual(ORIGINAL);
  });

  it('rejects with 409 when the job is not in complete status', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const job = await jobService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x', outputKind: 'theme' });
    // Still 'pending' — never marked complete.
    const res = await PATCH(patchRequest(EDITED), { params: Promise.resolve({ id: job.id }) });
    expect(res.status).toBe(409);
  });

  it('returns 404 for a nonexistent job', async () => {
    const res = await PATCH(patchRequest(EDITED), { params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' }) });
    expect(res.status).toBe(404);
  });
});
