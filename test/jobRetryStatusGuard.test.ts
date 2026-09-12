import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { jobService } from '@/lib/services/JobService';
import { seedSession } from '@/test/helpers/testSession';
import { POST } from '@/app/api/jobs/retry/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-jobretryguard-'));
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

async function makeJobWithStatus(ownerId: string, status: string) {
  const style = await styleService.create({ name: 'x', createdBy: ownerId, parameters: '{}' });
  const job = await jobService.create({ styleId: style.id, createdBy: ownerId, assetType: 'sprite', prompt: 'x' });
  DatabaseConnection.getInstance().prepare('UPDATE jobs SET status = ? WHERE id = ?').run(status, job.id);
  return job;
}

function retryRequest(jobId: string, cookieHeader: string) {
  return new NextRequest('http://localhost/api/jobs/retry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    body: JSON.stringify({ jobId }),
  });
}

describe('POST /api/jobs/retry — status guard', () => {
  it('409s a pending job instead of resetting it mid-flight', async () => {
    const { userId, cookieHeader } = await seedSession();
    const job = await makeJobWithStatus(userId, 'pending');
    const res = await POST(retryRequest(job.id, cookieHeader));
    expect(res.status).toBe(409);
  });

  it('409s a processing job instead of resetting it mid-flight', async () => {
    const { userId, cookieHeader } = await seedSession();
    const job = await makeJobWithStatus(userId, 'processing');
    const res = await POST(retryRequest(job.id, cookieHeader));
    expect(res.status).toBe(409);
  });

  it('409s an already-promoted job', async () => {
    const { userId, cookieHeader } = await seedSession();
    const job = await makeJobWithStatus(userId, 'promoted');
    const res = await POST(retryRequest(job.id, cookieHeader));
    expect(res.status).toBe(409);
  });

  it('allows retrying a failed job', async () => {
    const { userId, cookieHeader } = await seedSession();
    const job = await makeJobWithStatus(userId, 'failed');
    const res = await POST(retryRequest(job.id, cookieHeader));
    expect(res.status).toBe(200);
  });

  it('allows retrying a completed job (re-rolling a candidate the user does not want)', async () => {
    const { userId, cookieHeader } = await seedSession();
    const job = await makeJobWithStatus(userId, 'complete');
    const res = await POST(retryRequest(job.id, cookieHeader));
    expect(res.status).toBe(200);
  });
});
