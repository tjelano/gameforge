// test/presetApplyRoute.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { presetService } from '@/lib/services/PresetService';
import { seedSession } from './helpers/testSession';
import { POST as applyPreset } from '@/app/api/presets/[id]/apply/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-presetapplyroute-'));
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

function req(body: unknown, cookieHeader?: string): NextRequest {
  return new NextRequest('http://localhost/api/presets/x/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
    body: JSON.stringify(body),
  });
}

describe('POST /api/presets/[id]/apply', () => {
  it('requires login', async () => {
    const preset = await presetService.create({
      name: 'x', createdBy: 'user-1', prompt: 'x', techStackTags: '[]', themePrompt: 'a theme', components: '[]',
    });
    const res = await applyPreset(req({ newStyleName: 'x' }), { params: Promise.resolve({ id: preset.id }) });
    expect(res.status).toBe(401);
  });

  it('rejects a body with neither newStyleName nor existingStyleId', async () => {
    const { cookieHeader } = await seedSession();
    const preset = await presetService.create({
      name: 'x', createdBy: 'user-1', prompt: 'x', techStackTags: '[]', themePrompt: 'a theme', components: '[]',
    });
    const res = await applyPreset(req({}, cookieHeader), { params: Promise.resolve({ id: preset.id }) });
    expect(res.status).toBe(400);
  });

  it('rejects a body with BOTH newStyleName and existingStyleId', async () => {
    const { cookieHeader } = await seedSession();
    const preset = await presetService.create({
      name: 'x', createdBy: 'user-1', prompt: 'x', techStackTags: '[]', themePrompt: 'a theme', components: '[]',
    });
    const res = await applyPreset(
      req({ newStyleName: 'x', existingStyleId: '11111111-1111-1111-1111-111111111111' }, cookieHeader),
      { params: Promise.resolve({ id: preset.id }) }
    );
    expect(res.status).toBe(400);
  });

  it('applies successfully and returns styleId/batchId/jobIds', async () => {
    const { cookieHeader } = await seedSession();
    const preset = await presetService.create({
      name: 'x', createdBy: 'user-1', prompt: 'x', techStackTags: '[]', themePrompt: 'a theme',
      components: JSON.stringify([{ assetType: 'nav bar', prompt: 'a nav bar' }]),
    });
    const res = await applyPreset(req({ newStyleName: 'New Bible' }, cookieHeader), { params: Promise.resolve({ id: preset.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.jobIds).toHaveLength(2);
  });

  it('returns 400 for a preset with nothing to generate', async () => {
    const { cookieHeader } = await seedSession();
    const preset = await presetService.create({
      name: 'Empty', createdBy: 'user-1', prompt: 'x', techStackTags: '[]', themePrompt: null, components: '[]',
    });
    const res = await applyPreset(req({ newStyleName: 'x' }, cookieHeader), { params: Promise.resolve({ id: preset.id }) });
    expect(res.status).toBe(400);
  });

  it('returns 404 for a nonexistent preset', async () => {
    const { cookieHeader } = await seedSession();
    const res = await applyPreset(
      req({ newStyleName: 'x' }, cookieHeader),
      { params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' }) }
    );
    expect(res.status).toBe(404);
  });
});
