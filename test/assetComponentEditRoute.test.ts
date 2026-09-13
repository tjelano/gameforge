import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { seedSession } from './helpers/testSession';
import { styleService } from '@/lib/services/StyleService';
import { assetService } from '@/lib/services/AssetService';
import { PATCH } from '@/app/api/assets/[id]/component/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-assetcomponentedit-'));
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'components'), { recursive: true });
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
  return new NextRequest('http://localhost/api/assets/asset-1/component', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
    body: JSON.stringify(body),
  });
}

async function makeComponentAsset(styleId: string, createdBy: string) {
  const filename = 'comp.html';
  await fsPromises.writeFile(
    path.join(tempRoot, 'storage', 'components', filename),
    '<!DOCTYPE html><html><head><style>.btn{color:red;}</style></head><body><button class="btn">Go</button></body></html>'
  );
  return assetService.create({ styleId, createdBy, assetType: 'button', prompt: 'a button', imagePath: filename, outputKind: 'component' });
}

describe('PATCH /api/assets/[id]/component', () => {
  it('requires login', async () => {
    const { userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const asset = await makeComponentAsset(style.id, userId);
    const res = await PATCH(req({ html: '<button>Go</button>', css: '.btn{}' }), { params: Promise.resolve({ id: asset.id }) });
    expect(res.status).toBe(401);
  });

  it('returns 404 for a non-component asset', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const themeAsset = await assetService.create({ styleId: style.id, createdBy: userId, assetType: 'theme', prompt: 'x', imagePath: 'x.css', outputKind: 'theme' });
    const res = await PATCH(req({ html: '<a></a>', css: '' }, cookieHeader), { params: Promise.resolve({ id: themeAsset.id }) });
    expect(res.status).toBe(404);
  });

  it('sanitizes and rejects unsafe HTML when trustAsEdited is false or omitted', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const asset = await makeComponentAsset(style.id, userId);
    const res = await PATCH(req({ html: '<script>alert(1)</script><button>Go</button>', css: '.btn{}' }, cookieHeader), { params: Promise.resolve({ id: asset.id }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.html).not.toContain('<script>');

    const updated = await assetService.getById(asset.id);
    expect(updated!.edited_externally).toBe(0);
  });

  it('skips sanitization and sets edited_externally when trustAsEdited is true', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const asset = await makeComponentAsset(style.id, userId);
    // Something the narrow allowlist would normally strip (an <img> tag) -
    // proves sanitization was genuinely skipped, not just permissive by luck.
    const res = await PATCH(
      req({ html: '<img src="x.png" /><button>Go</button>', css: '.btn{color:blue;}', trustAsEdited: true }, cookieHeader),
      { params: Promise.resolve({ id: asset.id }) }
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.html).toContain('<img');

    const updated = await assetService.getById(asset.id);
    expect(updated!.edited_externally).toBe(1);
  });

  it('clears edited_externally on a subsequent ordinary (non-trusted) save', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const asset = await makeComponentAsset(style.id, userId);
    await PATCH(req({ html: '<button>Go</button>', css: '.btn{}', trustAsEdited: true }, cookieHeader), { params: Promise.resolve({ id: asset.id }) });
    expect((await assetService.getById(asset.id))!.edited_externally).toBe(1);

    await PATCH(req({ html: '<button>Go again</button>', css: '.btn{}' }, cookieHeader), { params: Promise.resolve({ id: asset.id }) });
    expect((await assetService.getById(asset.id))!.edited_externally).toBe(0);
  });

  it('returns 403 for a non-owner, non-admin user and does not write the file', async () => {
    const { userId: ownerId } = await seedSession('Owner');
    const { cookieHeader: attackerCookie } = await seedSession('Attacker');
    const style = await styleService.create({ name: 'S', createdBy: ownerId, parameters: '{}' });
    const asset = await makeComponentAsset(style.id, ownerId);

    const filePath = path.join(tempRoot, 'storage', 'components', 'comp.html');
    const before = await fsPromises.readFile(filePath, 'utf-8');

    const res = await PATCH(
      req({ html: '<button>Hacked</button>', css: '.btn{color:red;}' }, attackerCookie),
      { params: Promise.resolve({ id: asset.id }) }
    );
    expect(res.status).toBe(403);

    // Prove the write never happened - not just that the status code was right.
    const after = await fsPromises.readFile(filePath, 'utf-8');
    expect(after).toBe(before);
    expect(after).not.toContain('Hacked');

    const unchanged = await assetService.getById(asset.id);
    expect(unchanged!.edited_externally).toBe(0);
  });

  it('writes the file via combineComponentHtml either way', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const asset = await makeComponentAsset(style.id, userId);
    await PATCH(req({ html: '<button>Updated</button>', css: '.btn{color:green;}' }, cookieHeader), { params: Promise.resolve({ id: asset.id }) });

    const fileContent = await fsPromises.readFile(path.join(tempRoot, 'storage', 'components', 'comp.html'), 'utf-8');
    expect(fileContent).toContain('Updated');
    expect(fileContent).toContain('color:green');
  });
});
