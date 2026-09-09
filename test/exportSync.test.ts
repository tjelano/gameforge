// test/exportSync.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { pageService } from '@/lib/services/PageService';
import { assetService } from '@/lib/services/AssetService';
import { writeManifest, hashContent, type ExportManifest } from '@/lib/services/ExportManifest';
import { computeSyncDiff } from '@/lib/services/ExportSync';

let tempRoot: string;
let exportDir: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-exportsync-'));
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  exportDir = path.join(tempRoot, 'export');
  await fsPromises.mkdir(path.join(exportDir, 'app'), { recursive: true });
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

function pageFileContent(pageId: string, componentTags: string): string {
  return `// gameforge-page-id: ${pageId}\nexport default function Page() {\n  return (\n    <>\n${componentTags}\n    </>\n  );\n}\n`;
}

describe('computeSyncDiff', () => {
  it('returns an error when no manifest exists in the export directory', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const result = await computeSyncDiff(style.id, exportDir);
    expect(result.success).toBe(false);
  });

  it('detects a new page (a route folder whose page.tsx has no embedded page-id)', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await writeManifest(exportDir, { styleId: style.id, exportedAt: Date.now(), pages: [], components: [] });
    await fsPromises.mkdir(path.join(exportDir, 'app', 'about'), { recursive: true });
    await fsPromises.writeFile(path.join(exportDir, 'app', 'about', 'page.tsx'), 'export default function Page() { return <><p>hi</p></>; }');

    const result = await computeSyncDiff(style.id, exportDir);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.diff.newPages).toHaveLength(1);
    expect(result.diff.newPages[0].slug).toBe('about');
    expect(result.diff.newPages[0].name).toBe('About');
  });

  it('detects a page deleted externally (a manifest page-id with no matching route folder)', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const page = await pageService.create({ styleId: style.id, name: 'Contact', createdBy: 'user-1' });
    await writeManifest(exportDir, {
      styleId: style.id, exportedAt: Date.now(),
      pages: [{ id: page.id, name: 'Contact', slug: 'contact', componentAssetIds: [], pageFileHash: 'irrelevant' }],
      components: [],
    });
    // No app/contact directory written on disk at all.

    const result = await computeSyncDiff(style.id, exportDir);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.diff.deletedPageIds).toEqual([page.id]);
  });

  it('resolves a page by its embedded id even if the route folder was renamed', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const page = await pageService.create({ styleId: style.id, name: 'About', createdBy: 'user-1' });
    await writeManifest(exportDir, {
      styleId: style.id, exportedAt: Date.now(),
      pages: [{ id: page.id, name: 'About', slug: 'about-us', componentAssetIds: [], pageFileHash: 'irrelevant' }],
      components: [],
    });
    // Folder renamed by hand from "about-us" to "about" - the embedded id must still resolve it.
    await fsPromises.mkdir(path.join(exportDir, 'app', 'about'), { recursive: true });
    await fsPromises.writeFile(path.join(exportDir, 'app', 'about', 'page.tsx'), pageFileContent(page.id, ''));

    const result = await computeSyncDiff(style.id, exportDir);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.diff.newPages).toHaveLength(0);
    expect(result.diff.deletedPageIds).toHaveLength(0);
  });

  it('detects a reordered/added/removed set of component references on a known page', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const compA = await assetService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'navbar', prompt: 'nav', imagePath: 'a.html', outputKind: 'component' });
    const compB = await assetService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'hero', prompt: 'hero', imagePath: 'b.html', outputKind: 'component' });
    const page = await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    await pageService.update(page.id, { componentAssetIds: JSON.stringify([compA.id, compB.id]) });

    await writeManifest(exportDir, {
      styleId: style.id, exportedAt: Date.now(),
      pages: [{ id: page.id, name: 'Home', slug: '', componentAssetIds: [compA.id, compB.id], pageFileHash: 'irrelevant' }],
      components: [
        { assetId: compA.id, componentName: 'NavbarAAA111', contentHash: 'x' },
        { assetId: compB.id, componentName: 'HeroBBB222', contentHash: 'y' },
      ],
    });
    // Hand-edited order: hero now comes first (with an added attribute, to
    // also prove the regex tolerates that), navbar second.
    await fsPromises.writeFile(
      path.join(exportDir, 'app', 'page.tsx'),
      pageFileContent(page.id, '      <HeroBBB222 className="foo" />\n      <NavbarAAA111 />')
    );

    const result = await computeSyncDiff(style.id, exportDir);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.diff.pageOrderChanges).toHaveLength(1);
    expect(result.diff.pageOrderChanges[0].pageId).toBe(page.id);
    expect(result.diff.pageOrderChanges[0].newComponentAssetIds).toEqual([compB.id, compA.id]);
  });

  it('ignores a JSX tag that is not a known component name', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const comp = await assetService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'hero', prompt: 'hero', imagePath: 'a.html', outputKind: 'component' });
    const page = await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    await pageService.update(page.id, { componentAssetIds: JSON.stringify([comp.id]) });

    await writeManifest(exportDir, {
      styleId: style.id, exportedAt: Date.now(),
      pages: [{ id: page.id, name: 'Home', slug: '', componentAssetIds: [comp.id], pageFileHash: 'irrelevant' }],
      components: [{ assetId: comp.id, componentName: 'HeroAAA111', contentHash: 'x' }],
    });
    await fsPromises.writeFile(
      path.join(exportDir, 'app', 'page.tsx'),
      pageFileContent(page.id, '      <HeroAAA111 />\n      <SomeHandWrittenThing />')
    );

    const result = await computeSyncDiff(style.id, exportDir);
    expect(result.success).toBe(true);
    if (!result.success) return;
    // No change detected - the known component is still there in the same
    // position, and the unrecognized tag is simply not part of the tracked order.
    expect(result.diff.pageOrderChanges).toHaveLength(0);
  });

  it('detects a hand-edited component via a content hash mismatch', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const comp = await assetService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'hero', prompt: 'hero', imagePath: 'a.html', outputKind: 'component' });
    const page = await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    await pageService.update(page.id, { componentAssetIds: JSON.stringify([comp.id]) });

    await fsPromises.mkdir(path.join(exportDir, 'components'), { recursive: true });
    await fsPromises.writeFile(path.join(exportDir, 'components', 'HeroAAA111.tsx'), 'export function HeroAAA111() { return <div />; }');
    await fsPromises.writeFile(path.join(exportDir, 'components', 'HeroAAA111.module.css'), '.root {}');

    await writeManifest(exportDir, {
      styleId: style.id, exportedAt: Date.now(),
      pages: [{ id: page.id, name: 'Home', slug: '', componentAssetIds: [comp.id], pageFileHash: 'irrelevant' }],
      components: [{ assetId: comp.id, componentName: 'HeroAAA111', contentHash: hashContent('this-does-not-match-the-files-above') }],
    });
    await fsPromises.writeFile(path.join(exportDir, 'app', 'page.tsx'), pageFileContent(page.id, '      <HeroAAA111 />'));

    const result = await computeSyncDiff(style.id, exportDir);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.diff.handEditedComponentAssetIds).toEqual([comp.id]);
  });

  it('drops a component reference whose asset was soft-deleted after export, and reports it', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const compA = await assetService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'navbar', prompt: 'nav', imagePath: 'a.html', outputKind: 'component' });
    const compB = await assetService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'hero', prompt: 'hero', imagePath: 'b.html', outputKind: 'component' });
    const page = await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    await pageService.update(page.id, { componentAssetIds: JSON.stringify([compA.id, compB.id]) });
    await assetService.softDelete(compB.id);

    await writeManifest(exportDir, {
      styleId: style.id, exportedAt: Date.now(),
      pages: [{ id: page.id, name: 'Home', slug: '', componentAssetIds: [compA.id, compB.id], pageFileHash: 'irrelevant' }],
      components: [
        { assetId: compA.id, componentName: 'NavbarAAA111', contentHash: 'x' },
        { assetId: compB.id, componentName: 'HeroBBB222', contentHash: 'y' },
      ],
    });
    // The exported file still references both, unedited since export.
    await fsPromises.writeFile(
      path.join(exportDir, 'app', 'page.tsx'),
      pageFileContent(page.id, '      <NavbarAAA111 />\n      <HeroBBB222 />')
    );

    const result = await computeSyncDiff(style.id, exportDir);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.diff.droppedDeletedAssetIds).toEqual([compB.id]);
    // The page's own order didn't otherwise change (both refs were already
    // present at export time) except for dropping the now-deleted one.
    expect(result.diff.pageOrderChanges).toEqual([{ pageId: page.id, newComponentAssetIds: [compA.id] }]);
  });
});
