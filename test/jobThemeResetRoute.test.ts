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
import { POST } from '@/app/api/jobs/[id]/theme/reset/route';

let tempRoot: string;

const ORIGINAL: ThemeTokens = {
  colorBackground: '#1c1a17', colorForeground: '#ede7dc', colorAccent: '#e8a33d', colorBorder: '#3c352a',
  fontHeading: "'Cinzel', serif", fontBody: "'EB Garamond', serif", spaceUnit: '8px', radiusBase: '4px',
};
const EDITED: ThemeTokens = { ...ORIGINAL, colorAccent: '#2c7be5' };

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
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-jobthemereset-'));
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

describe('POST /api/jobs/[id]/theme/reset', () => {
  it('restores the file to the original tokens after an edit', async () => {
    const { jobId, filename } = await makeCompleteThemeJob();
    await PATCH(patchRequest(EDITED), { params: Promise.resolve({ id: jobId }) });

    const res = await POST(new NextRequest('http://localhost/x'), { params: Promise.resolve({ id: jobId }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual(ORIGINAL);

    const css = await fsPromises.readFile(path.join(tempRoot, 'storage', 'themes', filename), 'utf-8');
    expect(parseThemeCss(css)).toEqual(ORIGINAL);
  });

  it('returns 404 when the job has never been edited (no originalTokens captured)', async () => {
    const { jobId } = await makeCompleteThemeJob();
    const res = await POST(new NextRequest('http://localhost/x'), { params: Promise.resolve({ id: jobId }) });
    expect(res.status).toBe(404);
  });

  it('returns 404 for a nonexistent job', async () => {
    const res = await POST(new NextRequest('http://localhost/x'), { params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' }) });
    expect(res.status).toBe(404);
  });

  it('rejects with 409 once the job has been promoted, and does not touch the file', async () => {
    const { jobId, filename } = await makeCompleteThemeJob();
    await PATCH(patchRequest(EDITED), { params: Promise.resolve({ id: jobId }) });
    DatabaseConnection.getInstance().prepare("UPDATE jobs SET status = 'promoted' WHERE id = ?").run(jobId);

    const res = await POST(new NextRequest('http://localhost/x'), { params: Promise.resolve({ id: jobId }) });
    expect(res.status).toBe(409);

    const css = await fsPromises.readFile(path.join(tempRoot, 'storage', 'themes', filename), 'utf-8');
    expect(parseThemeCss(css)).toEqual(EDITED);
  });
});
