// test/generateComponentType.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { seedSession } from './helpers/testSession';
import { styleService } from '@/lib/services/StyleService';
import { POST } from '@/app/api/generate/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-gencomponenttype-'));
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
  return new NextRequest('http://localhost/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
    body: JSON.stringify(body),
  });
}

describe('POST /api/generate componentType/groundWithInspo threading', () => {
  it('stores componentType and the style\'s current groundWithInspo flag on the job\'s options', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'X', createdBy: userId, parameters: '{}' });
    await styleService.update(style.id, userId, { groundWithInspo: true });

    const res = await POST(req({
      styleId: style.id, assetType: 'component', prompt: 'A submit button',
      outputKind: 'component', options: { componentType: 'Button' },
    }, cookieHeader));
    const body = await res.json();
    expect(res.status).toBe(200);

    const db = DatabaseConnection.getInstance();
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(body.data.id) as any;
    const options = JSON.parse(job.options);
    expect(options.componentType).toBe('Button');
    expect(options.groundWithInspo).toBe(true);
  });

  it('defaults groundWithInspo to false when the style has not opted in', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'X', createdBy: userId, parameters: '{}' });

    const res = await POST(req({
      styleId: style.id, assetType: 'component', prompt: 'A card',
      outputKind: 'component', options: { componentType: 'Card' },
    }, cookieHeader));
    const body = await res.json();

    const db = DatabaseConnection.getInstance();
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(body.data.id) as any;
    const options = JSON.parse(job.options);
    expect(options.groundWithInspo).toBe(false);
  });

  it('drops an unrecognized componentType instead of storing it (e.g. Object.prototype keys)', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'X', createdBy: userId, parameters: '{}' });

    const res = await POST(req({
      styleId: style.id, assetType: 'component', prompt: 'A widget',
      outputKind: 'component', options: { componentType: 'constructor' },
    }, cookieHeader));
    const body = await res.json();
    expect(res.status).toBe(200);

    const db = DatabaseConnection.getInstance();
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(body.data.id) as any;
    const options = JSON.parse(job.options);
    expect(options.componentType).toBeUndefined();
  });
});
