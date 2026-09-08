import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { pageService } from '@/lib/services/PageService';
import { assetService } from '@/lib/services/AssetService';
import { siteExporter } from '@/lib/services/SiteExporter';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-siteexport-'));
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'components'), { recursive: true });
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'themes'), { recursive: true });
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

async function makeComponentAsset(styleId: string, filename: string, document: string) {
  await fsPromises.writeFile(path.join(tempRoot, 'storage', 'components', filename), document);
  return assetService.create({
    styleId,
    createdBy: 'user-1',
    assetType: 'button',
    prompt: 'a button',
    imagePath: filename,
    outputKind: 'component',
  });
}

const COMPONENT_DOC = '<!DOCTYPE html><html><head><style>.btn { color: red; }</style></head><body><button class="btn">Go</button></body></html>';

describe('siteExporter.exportSite', () => {
  it('exports two pages, deduplicating a component shared by both into one file', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const shared = await makeComponentAsset(style.id, 'shared.html', COMPONENT_DOC);
    const pageA = await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    const pageB = await pageService.create({ styleId: style.id, name: 'About', createdBy: 'user-1' });
    await pageService.update(pageA.id, { componentAssetIds: JSON.stringify([shared.id]) });
    await pageService.update(pageB.id, { componentAssetIds: JSON.stringify([shared.id]) });

    const result = await siteExporter.exportSite(style.id, 'test-export');
    expect(result).not.toHaveProperty('error');
    const ok = result as { pagesExported: number; componentsExported: number; targetDir: string };
    expect(ok.pagesExported).toBe(2);
    expect(ok.componentsExported).toBe(1);

    const componentFiles = await fsPromises.readdir(path.join(ok.targetDir, 'components'));
    const tsxFiles = componentFiles.filter(f => f.endsWith('.tsx'));
    expect(tsxFiles.length).toBe(1);
  });

  it('selects the oldest-created page as home (app/page.tsx), despite getActivePagesForStyle returning newest-first', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await pageService.create({ styleId: style.id, name: 'First', createdBy: 'user-1' });
    await new Promise(r => setTimeout(r, 5));
    await pageService.create({ styleId: style.id, name: 'Second', createdBy: 'user-1' });

    const result = await siteExporter.exportSite(style.id, 'test-home');
    const ok = result as { targetDir: string };
    // buildPageFile's output has no page-name text in it (it only emits
    // component imports/JSX) - so home-selection is proven by WHICH
    // slug directory exists, not by content. "First" (oldest) must be
    // the home page (app/page.tsx, no slug dir of its own); "Second"
    // (newest) must get its own slugified route directory.
    await expect(fsPromises.access(path.join(ok.targetDir, 'app', 'page.tsx'))).resolves.toBeUndefined();
    await expect(fsPromises.access(path.join(ok.targetDir, 'app', 'first'))).rejects.toThrow();
    await expect(fsPromises.access(path.join(ok.targetDir, 'app', 'second', 'page.tsx'))).resolves.toBeUndefined();
  });

  it('skips a stale (deleted) component reference without failing the export', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const valid = await makeComponentAsset(style.id, 'valid.html', COMPONENT_DOC);
    const stale = await makeComponentAsset(style.id, 'stale.html', COMPONENT_DOC);
    await assetService.softDelete(stale.id);
    const page = await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    await pageService.update(page.id, { componentAssetIds: JSON.stringify([valid.id, stale.id]) });

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await siteExporter.exportSite(style.id, 'test-stale');
      expect(result).not.toHaveProperty('error');
      const ok = result as { componentsExported: number };
      expect(ok.componentsExported).toBe(1);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('returns NOTHING_TO_EXPORT for a style with zero pages', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const result = await siteExporter.exportSite(style.id, 'test-empty');
    expect(result).toEqual({ error: 'NOTHING_TO_EXPORT' });
  });

  it('returns ALREADY_EXISTS if the target subdir already exists', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    const first = await siteExporter.exportSite(style.id, 'test-dup');
    expect(first).not.toHaveProperty('error');
    const second = await siteExporter.exportSite(style.id, 'test-dup');
    expect(second).toEqual({ error: 'ALREADY_EXISTS' });
  });

  it('writes a package.json with the pinned dependency versions and a package.json in the exported project', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    const result = await siteExporter.exportSite(style.id, 'test-pkg');
    const ok = result as { targetDir: string };
    const pkg = JSON.parse(await fsPromises.readFile(path.join(ok.targetDir, 'package.json'), 'utf-8'));
    expect(pkg.dependencies.next).toBe('^16.3.4');
    expect(pkg.dependencies.react).toBe('^19.1.0');
    expect(pkg.scripts.dev).toBe('next dev');
  });
});
