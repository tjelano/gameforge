import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { seedSession } from './helpers/testSession';
import { styleService } from '@/lib/services/StyleService';
import { pageService } from '@/lib/services/PageService';
import { assetService } from '@/lib/services/AssetService';
import { writeManifest } from '@/lib/services/ExportManifest';
import { POST as previewPost } from '@/app/api/styles/[id]/export-sync/preview/route';
import { POST as applyPost } from '@/app/api/styles/[id]/export-sync/apply/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-exportsyncroute-'));
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
  return new NextRequest('http://localhost/api/styles/style-1/export-sync/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
    body: JSON.stringify(body),
  });
}

describe('POST /api/styles/[id]/export-sync/preview', () => {
  it('requires login', async () => {
    const { userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const res = await previewPost(req({ subdir: 'my-site' }), { params: Promise.resolve({ id: style.id }) });
    expect(res.status).toBe(401);
  });

  it('returns a 400 with a clear error when no export exists for this subdir', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const res = await previewPost(req({ subdir: 'nonexistent' }, cookieHeader), { params: Promise.resolve({ id: style.id }) });
    expect(res.status).toBe(400);
  });

  it('returns the computed diff for a real export directory', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const exportDir = path.join(tempRoot, 'storage', 'exports', 'my-site');
    await fsPromises.mkdir(path.join(exportDir, 'app'), { recursive: true });
    await writeManifest(exportDir, { styleId: style.id, exportedAt: Date.now(), pages: [], components: [] });
    await fsPromises.mkdir(path.join(exportDir, 'app', 'about'), { recursive: true });
    await fsPromises.writeFile(path.join(exportDir, 'app', 'about', 'page.tsx'), 'export default function Page() { return <><p>hi</p></>; }');

    const res = await previewPost(req({ subdir: 'my-site' }, cookieHeader), { params: Promise.resolve({ id: style.id }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.newPages).toHaveLength(1);
  });

  it('returns 409 when an export is currently in progress for this subdir', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const lockDir = path.join(tempRoot, 'storage', 'exports', '.locks', 'my-site.lock');
    await fsPromises.mkdir(lockDir, { recursive: true });
    await fsPromises.writeFile(path.join(lockDir, 'heartbeat'), String(Date.now()));

    const res = await previewPost(req({ subdir: 'my-site' }, cookieHeader), { params: Promise.resolve({ id: style.id }) });
    expect(res.status).toBe(409);
  });
});

describe('POST /api/styles/[id]/export-sync/apply', () => {
  it('requires login', async () => {
    const { userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const res = await applyPost(req({ subdir: 'my-site' }), { params: Promise.resolve({ id: style.id }) });
    expect(res.status).toBe(401);
  });

  it('creates a new page for a route folder with no matching manifest entry', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const exportDir = path.join(tempRoot, 'storage', 'exports', 'my-site');
    await fsPromises.mkdir(path.join(exportDir, 'app'), { recursive: true });
    await writeManifest(exportDir, { styleId: style.id, exportedAt: Date.now(), pages: [], components: [] });
    await fsPromises.mkdir(path.join(exportDir, 'app', 'about'), { recursive: true });
    await fsPromises.writeFile(path.join(exportDir, 'app', 'about', 'page.tsx'), 'export default function Page() { return <><p>hi</p></>; }');

    const res = await applyPost(req({ subdir: 'my-site' }, cookieHeader), { params: Promise.resolve({ id: style.id }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);

    const pages = await pageService.getActivePagesForStyle(style.id);
    expect(pages.map(p => p.name)).toContain('About');
  });

  it('soft-deletes a page whose route folder no longer exists', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const page = await pageService.create({ styleId: style.id, name: 'Contact', createdBy: userId });
    const exportDir = path.join(tempRoot, 'storage', 'exports', 'my-site');
    await fsPromises.mkdir(path.join(exportDir, 'app'), { recursive: true });
    await writeManifest(exportDir, {
      styleId: style.id, exportedAt: Date.now(),
      pages: [{ id: page.id, name: 'Contact', slug: 'contact', componentAssetIds: [], pageFileHash: 'x' }],
      components: [],
    });

    const res = await applyPost(req({ subdir: 'my-site' }, cookieHeader), { params: Promise.resolve({ id: style.id }) });
    expect(res.status).toBe(200);

    const pages = await pageService.getActivePagesForStyle(style.id);
    expect(pages.find(p => p.id === page.id)).toBeUndefined();
  });

  it('updates an existing page\'s component order', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const comp = await assetService.create({ styleId: style.id, createdBy: userId, assetType: 'hero', prompt: 'hero', imagePath: 'a.html', outputKind: 'component' });
    const page = await pageService.create({ styleId: style.id, name: 'Home', createdBy: userId });
    await pageService.update(page.id, userId, { componentAssetIds: JSON.stringify([]) });

    const exportDir = path.join(tempRoot, 'storage', 'exports', 'my-site');
    await fsPromises.mkdir(path.join(exportDir, 'app'), { recursive: true });
    await writeManifest(exportDir, {
      styleId: style.id, exportedAt: Date.now(),
      pages: [{ id: page.id, name: 'Home', slug: '', componentAssetIds: [], pageFileHash: 'x' }],
      components: [{ assetId: comp.id, componentName: 'HeroAAA111', contentHash: 'y' }],
    });
    await fsPromises.writeFile(
      path.join(exportDir, 'app', 'page.tsx'),
      `// gameforge-page-id: ${page.id}\nexport default function Page() { return (<><HeroAAA111 /></>); }`
    );

    const res = await applyPost(req({ subdir: 'my-site' }, cookieHeader), { params: Promise.resolve({ id: style.id }) });
    expect(res.status).toBe(200);

    const updated = await pageService.getById(page.id);
    expect(JSON.parse(updated!.component_asset_ids)).toEqual([comp.id]);
  });

  it('ignores diff-shaped data in the request body and recomputes server-side', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const exportDir = path.join(tempRoot, 'storage', 'exports', 'my-site');
    await fsPromises.mkdir(path.join(exportDir, 'app'), { recursive: true });
    await writeManifest(exportDir, { styleId: style.id, exportedAt: Date.now(), pages: [], components: [] });
    // No actual new page directory on disk - only a fabricated client-side diff claiming one.

    const res = await applyPost(
      req({ subdir: 'my-site', diff: { newPages: [{ slug: 'fake', name: 'Fake', componentAssetIds: [] }] } }, cookieHeader),
      { params: Promise.resolve({ id: style.id }) }
    );
    expect(res.status).toBe(200);

    const pages = await pageService.getActivePagesForStyle(style.id);
    expect(pages.map(p => p.name)).not.toContain('Fake');
  });

  it('returns 409 when an export is currently in progress for this subdir, without touching the DB', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const exportDir = path.join(tempRoot, 'storage', 'exports', 'my-site');
    await fsPromises.mkdir(path.join(exportDir, 'app'), { recursive: true });
    await writeManifest(exportDir, { styleId: style.id, exportedAt: Date.now(), pages: [], components: [] });
    await fsPromises.mkdir(path.join(exportDir, 'app', 'about'), { recursive: true });
    await fsPromises.writeFile(path.join(exportDir, 'app', 'about', 'page.tsx'), 'export default function Page() { return <><p>hi</p></>; }');

    const lockDir = path.join(tempRoot, 'storage', 'exports', '.locks', 'my-site.lock');
    await fsPromises.mkdir(lockDir, { recursive: true });
    await fsPromises.writeFile(path.join(lockDir, 'heartbeat'), String(Date.now()));

    const res = await applyPost(req({ subdir: 'my-site' }, cookieHeader), { params: Promise.resolve({ id: style.id }) });
    expect(res.status).toBe(409);

    const pages = await pageService.getActivePagesForStyle(style.id);
    expect(pages).toHaveLength(0);
  });
});
