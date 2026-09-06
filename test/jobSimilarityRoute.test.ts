import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { assetService } from '@/lib/services/AssetService';
import { jobService } from '@/lib/services/JobService';
import { tokensToCss, type ThemeTokens } from '@/lib/services/ThemeGenerator';
import { GET } from '@/app/api/jobs/[id]/similarity/route';

let tempRoot: string;

const MOCK: ThemeTokens = {
  colorBackground: '#1c1a17', colorForeground: '#ede7dc', colorAccent: '#e8a33d', colorBorder: '#3c352a',
  fontHeading: "'Cinzel', serif", fontBody: "'EB Garamond', serif", spaceUnit: '8px', radiusBase: '4px',
};
const ALMOST_MOCK: ThemeTokens = { ...MOCK, colorAccent: '#e8a340' };
const FLATLY: ThemeTokens = {
  colorBackground: '#fff', colorForeground: '#212529', colorAccent: '#2c3e50', colorBorder: '#dee2e6',
  fontHeading: "'Lato', sans-serif", fontBody: "'Lato', sans-serif", spaceUnit: '0.5rem', radiusBase: '0.375rem',
};

async function makeThemeJob(styleId: string, tokens: ThemeTokens, batchId: string | null): Promise<string> {
  const filename = `job-${crypto.randomUUID()}.css`;
  await fsPromises.writeFile(path.join(tempRoot, 'storage', 'themes', filename), tokensToCss(tokens));
  const job = await jobService.create({ styleId, createdBy: 'user-1', assetType: 'theme', prompt: 'x', outputKind: 'theme' });
  const db = DatabaseConnection.getInstance();
  db.prepare("UPDATE jobs SET status = 'complete', result_path = ?, batch_id = ? WHERE id = ?").run(filename, batchId, job.id);
  return job.id;
}

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-jobsimilarity-'));
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

describe('GET /api/jobs/[id]/similarity', () => {
  it('flags a candidate too similar to an already-promoted asset of the same style', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const promotedFilename = 'promoted.css';
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'themes', promotedFilename), tokensToCss(MOCK));
    await assetService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x', imagePath: promotedFilename, outputKind: 'theme' });

    const jobId = await makeThemeJob(style.id, ALMOST_MOCK, null);
    const req = new NextRequest(`http://localhost/api/jobs/${jobId}/similarity`);
    const res = await GET(req, { params: Promise.resolve({ id: jobId }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.flagged).toBe(true);
  });

  it('flags a candidate too similar to a sibling job in the same batch', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const batchId = '55555555-5555-5555-5555-555555555555';
    await makeThemeJob(style.id, MOCK, batchId);
    const siblingId = await makeThemeJob(style.id, ALMOST_MOCK, batchId);

    const req = new NextRequest(`http://localhost/api/jobs/${siblingId}/similarity`);
    const res = await GET(req, { params: Promise.resolve({ id: siblingId }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.flagged).toBe(true);
  });

  it('does not flag a candidate that is genuinely different from everything else', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const promotedFilename = 'promoted.css';
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'themes', promotedFilename), tokensToCss(MOCK));
    await assetService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x', imagePath: promotedFilename, outputKind: 'theme' });

    const jobId = await makeThemeJob(style.id, FLATLY, null);
    const req = new NextRequest(`http://localhost/api/jobs/${jobId}/similarity`);
    const res = await GET(req, { params: Promise.resolve({ id: jobId }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.flagged).toBe(false);
  });

  it('never flags a candidate against a DIFFERENT style\'s promoted assets', async () => {
    const styleA = await styleService.create({ name: 'A', createdBy: 'user-1', parameters: '{}' });
    const styleB = await styleService.create({ name: 'B', createdBy: 'user-1', parameters: '{}' });
    const promotedFilename = 'promoted.css';
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'themes', promotedFilename), tokensToCss(MOCK));
    await assetService.create({ styleId: styleB.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x', imagePath: promotedFilename, outputKind: 'theme' });

    const jobId = await makeThemeJob(styleA.id, ALMOST_MOCK, null);
    const req = new NextRequest(`http://localhost/api/jobs/${jobId}/similarity`);
    const res = await GET(req, { params: Promise.resolve({ id: jobId }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.flagged).toBe(false);
  });

  it('returns 404 for a nonexistent job', async () => {
    const req = new NextRequest('http://localhost/api/jobs/00000000-0000-0000-0000-000000000000/similarity');
    const res = await GET(req, { params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' }) });
    expect(res.status).toBe(404);
  });

  it('returns flagged:false (not an error) for a non-theme job', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const job = await jobService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'sprite', prompt: 'x', outputKind: 'image' });
    const req = new NextRequest(`http://localhost/api/jobs/${job.id}/similarity`);
    const res = await GET(req, { params: Promise.resolve({ id: job.id }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.flagged).toBe(false);
  });
});
