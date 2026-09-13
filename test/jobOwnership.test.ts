// test/jobOwnership.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { jobService } from '@/lib/services/JobService';
import { userService } from '@/lib/services/UserService';
import { sessionService } from '@/lib/services/SessionService';
import { DELETE as deleteJob } from '@/app/api/jobs/[id]/route';
import { PATCH as patchComponent } from '@/app/api/jobs/[id]/component/route';
import { POST as resetComponent } from '@/app/api/jobs/[id]/component/reset/route';
import { PATCH as patchTheme } from '@/app/api/jobs/[id]/theme/route';
import { POST as resetTheme } from '@/app/api/jobs/[id]/theme/reset/route';
import { POST as retryJob } from '@/app/api/jobs/retry/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-jobownership-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'images'), { recursive: true });
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'components'), { recursive: true });
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

async function makeJob(ownerId: string): Promise<{ id: string }> {
  const style = await styleService.create({ name: 'x', createdBy: ownerId, parameters: '{}' });
  return jobService.create({ styleId: style.id, createdBy: ownerId, assetType: 'sprite', prompt: 'x' });
}

async function seedOwnerAndStranger() {
  await userService.create({ name: 'Admin' }); // first user = admin, not relevant here
  const owner = await userService.create({ name: 'Owner' });
  const stranger = await userService.create({ name: 'Stranger' });
  const { token } = await sessionService.create(stranger.id);
  return { owner, stranger, cookieHeader: `session=${token}` };
}

describe('job ownership — DELETE /api/jobs/[id]', () => {
  it('401s when not logged in', async () => {
    const job = await makeJob('user-1');
    const res = await deleteJob(new NextRequest(`http://localhost/api/jobs/${job.id}`, { method: 'DELETE' }), { params: Promise.resolve({ id: job.id }) });
    expect(res.status).toBe(401);
  });

  it('403s a non-owner, non-admin user', async () => {
    const { owner, cookieHeader } = await seedOwnerAndStranger();
    const job = await makeJob(owner.id);
    const req = new NextRequest(`http://localhost/api/jobs/${job.id}`, { method: 'DELETE', headers: { Cookie: cookieHeader } });
    const res = await deleteJob(req, { params: Promise.resolve({ id: job.id }) });
    expect(res.status).toBe(403);
  });
});

describe('job ownership — PATCH /api/jobs/[id]/component', () => {
  it('403s a non-owner, non-admin user', async () => {
    const { owner, cookieHeader } = await seedOwnerAndStranger();
    const job = await makeJob(owner.id);
    const req = new NextRequest(`http://localhost/x`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ html: '<div></div>', css: '' }),
    });
    const res = await patchComponent(req, { params: Promise.resolve({ id: job.id }) });
    expect(res.status).toBe(403);
  });
});

describe('job ownership — POST /api/jobs/[id]/component/reset', () => {
  it('403s a non-owner, non-admin user', async () => {
    const { owner, cookieHeader } = await seedOwnerAndStranger();
    const job = await makeJob(owner.id);
    const req = new NextRequest(`http://localhost/x`, { method: 'POST', headers: { Cookie: cookieHeader } });
    const res = await resetComponent(req, { params: Promise.resolve({ id: job.id }) });
    expect(res.status).toBe(403);
  });
});

describe('job ownership — PATCH /api/jobs/[id]/theme', () => {
  it('403s a non-owner, non-admin user', async () => {
    const { owner, cookieHeader } = await seedOwnerAndStranger();
    const job = await makeJob(owner.id);
    const req = new NextRequest(`http://localhost/x`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({}),
    });
    const res = await patchTheme(req, { params: Promise.resolve({ id: job.id }) });
    expect(res.status).toBe(403);
  });
});

describe('job ownership — POST /api/jobs/[id]/theme/reset', () => {
  it('403s a non-owner, non-admin user', async () => {
    const { owner, cookieHeader } = await seedOwnerAndStranger();
    const job = await makeJob(owner.id);
    const req = new NextRequest(`http://localhost/x`, { method: 'POST', headers: { Cookie: cookieHeader } });
    const res = await resetTheme(req, { params: Promise.resolve({ id: job.id }) });
    expect(res.status).toBe(403);
  });
});

describe('job ownership — POST /api/jobs/retry', () => {
  it('403s a non-owner, non-admin user', async () => {
    const { owner, cookieHeader } = await seedOwnerAndStranger();
    const job = await makeJob(owner.id);
    const req = new NextRequest('http://localhost/api/jobs/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ jobId: job.id }),
    });
    const res = await retryJob(req);
    expect(res.status).toBe(403);
  });

  it('lets a non-owner admin retry it', async () => {
    const admin = await userService.create({ name: 'Admin' });
    const other = await userService.create({ name: 'Other' });
    const { token } = await sessionService.create(admin.id);
    const job = await makeJob(other.id);
    DatabaseConnection.getInstance().prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").run(job.id);
    const req = new NextRequest('http://localhost/api/jobs/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `session=${token}` },
      body: JSON.stringify({ jobId: job.id }),
    });
    const res = await retryJob(req);
    expect(res.status).toBe(200);
  });
});
