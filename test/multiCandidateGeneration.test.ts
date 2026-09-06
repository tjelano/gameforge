// test/multiCandidateGeneration.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { jobService } from '@/lib/services/JobService';
import { buildThemePrompt } from '@/lib/services/ThemeGenerator';
import { POST } from '@/app/api/generate/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-multicandidate-'));
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

describe('buildThemePrompt with steering context', () => {
  it('includes avoid-colors context when provided', () => {
    const prompt = buildThemePrompt('{}', 'warm and cozy', ['#1c1a17', '#ede7dc']);
    expect(prompt).toContain('#1c1a17');
    expect(prompt).toContain('#ede7dc');
  });

  it('produces the same prompt as before when no avoid-colors are given (backward compatible)', () => {
    const withEmpty = buildThemePrompt('{}', 'warm and cozy', []);
    const withUndefined = buildThemePrompt('{}', 'warm and cozy');
    expect(withEmpty).toBe(withUndefined);
  });
});

describe('POST /api/generate with candidateCount', () => {
  it('creates 3 jobs sharing one batch_id when candidateCount is 3', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const req = new NextRequest('http://localhost/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x', outputKind: 'theme', candidateCount: 3,
      }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(3);
    const batchIds = new Set(body.data.map((j: any) => j.batch_id));
    expect(batchIds.size).toBe(1);
    expect([...batchIds][0]).not.toBeNull();
  });

  it('creates exactly 1 job with batch_id null when candidateCount is omitted (backward compatible)', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const req = new NextRequest('http://localhost/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x', outputKind: 'theme' }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.id).toBeDefined();
    expect(body.data.batch_id).toBeNull();
  });

  it('rejects an invalid candidateCount', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const req = new NextRequest('http://localhost/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x', outputKind: 'theme', candidateCount: 4 }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
