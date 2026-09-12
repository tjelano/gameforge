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

  it('does NOT adopt a non-canonically-named route folder as a new page (reports it as not importable instead)', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await writeManifest(exportDir, { styleId: style.id, exportedAt: Date.now(), pages: [], components: [] });
    // Hand-added folder using a naming convention GameForge's own slugify()
    // would never produce.
    await fsPromises.mkdir(path.join(exportDir, 'app', 'my_page'), { recursive: true });
    await fsPromises.writeFile(path.join(exportDir, 'app', 'my_page', 'page.tsx'), 'export default function Page() { return <><p>hi</p></>; }');

    const result = await computeSyncDiff(style.id, exportDir);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.diff.notImportableFolders).toEqual(['my_page']);
    expect(result.diff.newPages).toHaveLength(0);
  });

  it('still detects a canonically-slugged route folder as a new page (regression check)', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await writeManifest(exportDir, { styleId: style.id, exportedAt: Date.now(), pages: [], components: [] });
    await fsPromises.mkdir(path.join(exportDir, 'app', 'my-page'), { recursive: true });
    await fsPromises.writeFile(path.join(exportDir, 'app', 'my-page', 'page.tsx'), 'export default function Page() { return <><p>hi</p></>; }');

    const result = await computeSyncDiff(style.id, exportDir);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.diff.newPages).toHaveLength(1);
    expect(result.diff.newPages[0].slug).toBe('my-page');
    expect(result.diff.notImportableFolders).toHaveLength(0);
  });

  it('does not match a page-id comment that only appears inside a string literal, not as the first line', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await writeManifest(exportDir, { styleId: style.id, exportedAt: Date.now(), pages: [], components: [] });
    await fsPromises.mkdir(path.join(exportDir, 'app', 'about'), { recursive: true });
    await fsPromises.writeFile(
      path.join(exportDir, 'app', 'about', 'page.tsx'),
      "export default function Page() {\n  const x = '// gameforge-page-id: fake-id';\n  return <><p>{x}</p></>;\n}\n"
    );

    const result = await computeSyncDiff(style.id, exportDir);
    expect(result.success).toBe(true);
    if (!result.success) return;
    // Must be treated as a real new page (no valid id extracted), not
    // silently attributed to "fake-id".
    expect(result.diff.newPages).toHaveLength(1);
    expect(result.diff.newPages[0].slug).toBe('about');
  });

  it('does not match a page-id comment embedded after a newline inside a multi-line template literal', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await writeManifest(exportDir, { styleId: style.id, exportedAt: Date.now(), pages: [], components: [] });
    await fsPromises.mkdir(path.join(exportDir, 'app', 'about'), { recursive: true });
    // The fake comment sits on its own line, but only because it's inside a
    // multi-line template literal - it is not the file's true first line.
    // A regex anchored with the `m` flag would match here (m makes `^`
    // match after ANY newline, not just true string-start); anchoring
    // without `m` must not.
    await fsPromises.writeFile(
      path.join(exportDir, 'app', 'about', 'page.tsx'),
      "export default function Page() {\n  const x = `foo\n// gameforge-page-id: fake-id\nbar`;\n  return <><p>{x}</p></>;\n}\n"
    );

    const result = await computeSyncDiff(style.id, exportDir);
    expect(result.success).toBe(true);
    if (!result.success) return;
    // Must be treated as a real new page (no valid id extracted), not
    // silently attributed to "fake-id".
    expect(result.diff.newPages).toHaveLength(1);
    expect(result.diff.newPages[0].slug).toBe('about');
  });

  it('still matches a real first-line page-id comment (regression check for the anchored regex)', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const page = await pageService.create({ styleId: style.id, name: 'About', createdBy: 'user-1' });
    await writeManifest(exportDir, {
      styleId: style.id, exportedAt: Date.now(),
      pages: [{ id: page.id, name: 'About', slug: 'about', componentAssetIds: [], pageFileHash: 'irrelevant' }],
      components: [],
    });
    await fsPromises.mkdir(path.join(exportDir, 'app', 'about'), { recursive: true });
    await fsPromises.writeFile(path.join(exportDir, 'app', 'about', 'page.tsx'), pageFileContent(page.id, ''));

    const result = await computeSyncDiff(style.id, exportDir);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.diff.newPages).toHaveLength(0);
    expect(result.diff.deletedPageIds).toHaveLength(0);
    expect(result.diff.notImportableFolders).toHaveLength(0);
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
    // Disk-only reorder (DB order still matches the manifest's recorded
    // ancestor order) - the 3-way diff must not treat this as a conflict.
    expect(result.diff.conflictedPageIds).not.toContain(page.id);
  });

  it('does NOT report a page-order change when only the dashboard reordered since export (disk untouched)', async () => {
    // This is the bug this task fixes: disk still holds the exported
    // ("ancestor") order, but the DB was reordered in the dashboard after
    // export. The old disk-vs-current comparison flagged this as "changed
    // on disk" and Apply would silently revert the dashboard's own edit.
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const compA = await assetService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'navbar', prompt: 'nav', imagePath: 'a.html', outputKind: 'component' });
    const compB = await assetService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'hero', prompt: 'hero', imagePath: 'b.html', outputKind: 'component' });
    const page = await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    // Reordered in the dashboard after export: B now comes first.
    await pageService.update(page.id, { componentAssetIds: JSON.stringify([compB.id, compA.id]) });

    await writeManifest(exportDir, {
      styleId: style.id, exportedAt: Date.now(),
      pages: [{ id: page.id, name: 'Home', slug: '', componentAssetIds: [compA.id, compB.id], pageFileHash: 'irrelevant' }],
      components: [
        { assetId: compA.id, componentName: 'NavbarAAA111', contentHash: 'x' },
        { assetId: compB.id, componentName: 'HeroBBB222', contentHash: 'y' },
      ],
    });
    // Disk untouched since export - still the original exported order.
    await fsPromises.writeFile(
      path.join(exportDir, 'app', 'page.tsx'),
      pageFileContent(page.id, '      <NavbarAAA111 />\n      <HeroBBB222 />')
    );

    const result = await computeSyncDiff(style.id, exportDir);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.diff.pageOrderChanges).toHaveLength(0);
    expect(result.diff.conflictedPageIds).not.toContain(page.id);
  });

  it('reports a conflict when both the dashboard and disk reordered a page differently since export', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const compA = await assetService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'navbar', prompt: 'nav', imagePath: 'a.html', outputKind: 'component' });
    const compB = await assetService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'hero', prompt: 'hero', imagePath: 'b.html', outputKind: 'component' });
    const compC = await assetService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'footer', prompt: 'footer', imagePath: 'c.html', outputKind: 'component' });
    const page = await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    // Dashboard swaps B and C relative to the exported order.
    await pageService.update(page.id, { componentAssetIds: JSON.stringify([compA.id, compC.id, compB.id]) });

    await writeManifest(exportDir, {
      styleId: style.id, exportedAt: Date.now(),
      pages: [{ id: page.id, name: 'Home', slug: '', componentAssetIds: [compA.id, compB.id, compC.id], pageFileHash: 'irrelevant' }],
      components: [
        { assetId: compA.id, componentName: 'NavbarAAA111', contentHash: 'x' },
        { assetId: compB.id, componentName: 'HeroBBB222', contentHash: 'y' },
        { assetId: compC.id, componentName: 'FooterCCC333', contentHash: 'z' },
      ],
    });
    // Disk (hand-edited) swaps A and B relative to the exported order -
    // a different change than the dashboard's, so the two disagree.
    await fsPromises.writeFile(
      path.join(exportDir, 'app', 'page.tsx'),
      pageFileContent(page.id, '      <HeroBBB222 />\n      <NavbarAAA111 />\n      <FooterCCC333 />')
    );

    const result = await computeSyncDiff(style.id, exportDir);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.diff.conflictedPageIds).toContain(page.id);
    expect(result.diff.pageOrderChanges.find(c => c.pageId === page.id)).toBeUndefined();
  });

  it('does not report a conflict when the dashboard and disk independently converged on the same new order', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const compA = await assetService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'navbar', prompt: 'nav', imagePath: 'a.html', outputKind: 'component' });
    const compB = await assetService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'hero', prompt: 'hero', imagePath: 'b.html', outputKind: 'component' });
    const compC = await assetService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'footer', prompt: 'footer', imagePath: 'c.html', outputKind: 'component' });
    const page = await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    // Dashboard and disk both moved B to the front - the exact same result.
    await pageService.update(page.id, { componentAssetIds: JSON.stringify([compB.id, compA.id, compC.id]) });

    await writeManifest(exportDir, {
      styleId: style.id, exportedAt: Date.now(),
      pages: [{ id: page.id, name: 'Home', slug: '', componentAssetIds: [compA.id, compB.id, compC.id], pageFileHash: 'irrelevant' }],
      components: [
        { assetId: compA.id, componentName: 'NavbarAAA111', contentHash: 'x' },
        { assetId: compB.id, componentName: 'HeroBBB222', contentHash: 'y' },
        { assetId: compC.id, componentName: 'FooterCCC333', contentHash: 'z' },
      ],
    });
    await fsPromises.writeFile(
      path.join(exportDir, 'app', 'page.tsx'),
      pageFileContent(page.id, '      <HeroBBB222 />\n      <NavbarAAA111 />\n      <FooterCCC333 />')
    );

    const result = await computeSyncDiff(style.id, exportDir);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.diff.conflictedPageIds).not.toContain(page.id);
    expect(result.diff.pageOrderChanges.find(c => c.pageId === page.id)).toBeUndefined();
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

  it('skips the hand-edit check for a manifest componentName that attempts path traversal', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const comp = await assetService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'hero', prompt: 'hero', imagePath: 'a.html', outputKind: 'component' });
    const page = await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    await pageService.update(page.id, { componentAssetIds: JSON.stringify([comp.id]) });

    await fsPromises.mkdir(path.join(exportDir, 'components'), { recursive: true });
    // '../../evil' from exportDir/components resolves to tempRoot/evil - i.e.
    // outside exportDir entirely. Planting real files there proves the guard
    // (not a missing-file ENOENT) is what keeps this asset out of the result:
    // if the traversal guard were absent, these files exist and would be read.
    await fsPromises.writeFile(path.join(tempRoot, 'evil.tsx'), 'export function Evil() { return <div />; }');
    await fsPromises.writeFile(path.join(tempRoot, 'evil.module.css'), '.root {}');

    await writeManifest(exportDir, {
      styleId: style.id, exportedAt: Date.now(),
      pages: [{ id: page.id, name: 'Home', slug: '', componentAssetIds: [comp.id], pageFileHash: 'irrelevant' }],
      components: [{ assetId: comp.id, componentName: '../../evil', contentHash: 'irrelevant' }],
    });
    await fsPromises.writeFile(path.join(exportDir, 'app', 'page.tsx'), pageFileContent(page.id, ''));

    const result = await computeSyncDiff(style.id, exportDir);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.diff.handEditedComponentAssetIds).not.toContain(comp.id);
  });

  it('keeps reporting an accepted hand-edit baseline until the asset is marked reconciled (edited_externally)', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const comp = await assetService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'hero', prompt: 'hero', imagePath: 'a.html', outputKind: 'component' });
    const page = await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    await pageService.update(page.id, { componentAssetIds: JSON.stringify([comp.id]) });

    await fsPromises.mkdir(path.join(exportDir, 'components'), { recursive: true });
    const tsx = 'export function HeroAAA111() { return <div />; }';
    const css = '.root {}';
    await fsPromises.writeFile(path.join(exportDir, 'components', 'HeroAAA111.tsx'), tsx);
    await fsPromises.writeFile(path.join(exportDir, 'components', 'HeroAAA111.module.css'), css);

    // Manifest records the ACCEPTED hand-edit baseline (Task 16) - on-disk
    // hash matches contentHash - but the asset itself has not been marked
    // reconciled (edited_externally still 0).
    await writeManifest(exportDir, {
      styleId: style.id, exportedAt: Date.now(),
      pages: [{ id: page.id, name: 'Home', slug: '', componentAssetIds: [comp.id], pageFileHash: 'irrelevant' }],
      components: [{ assetId: comp.id, componentName: 'HeroAAA111', contentHash: hashContent(tsx + '\n' + css), handEdited: true }],
    });
    await fsPromises.writeFile(path.join(exportDir, 'app', 'page.tsx'), pageFileContent(page.id, '      <HeroAAA111 />'));

    const result = await computeSyncDiff(style.id, exportDir);
    expect(result.success).toBe(true);
    if (!result.success) return;
    // Notification must keep firing - the user has not yet reconciled this
    // hand-edit into the dashboard asset, even though the hash now matches.
    expect(result.diff.handEditedComponentAssetIds).toEqual([comp.id]);
  });

  it('stops reporting an accepted hand-edit once the asset is marked reconciled (edited_externally = 1)', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const comp = await assetService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'hero', prompt: 'hero', imagePath: 'a.html', outputKind: 'component' });
    await assetService.update(comp.id, 'user-1', { editedExternally: true });
    const page = await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    await pageService.update(page.id, { componentAssetIds: JSON.stringify([comp.id]) });

    await fsPromises.mkdir(path.join(exportDir, 'components'), { recursive: true });
    const tsx = 'export function HeroAAA111() { return <div />; }';
    const css = '.root {}';
    await fsPromises.writeFile(path.join(exportDir, 'components', 'HeroAAA111.tsx'), tsx);
    await fsPromises.writeFile(path.join(exportDir, 'components', 'HeroAAA111.module.css'), css);

    await writeManifest(exportDir, {
      styleId: style.id, exportedAt: Date.now(),
      pages: [{ id: page.id, name: 'Home', slug: '', componentAssetIds: [comp.id], pageFileHash: 'irrelevant' }],
      components: [{ assetId: comp.id, componentName: 'HeroAAA111', contentHash: hashContent(tsx + '\n' + css), handEdited: true }],
    });
    await fsPromises.writeFile(path.join(exportDir, 'app', 'page.tsx'), pageFileContent(page.id, '      <HeroAAA111 />'));

    const result = await computeSyncDiff(style.id, exportDir);
    expect(result.success).toBe(true);
    if (!result.success) return;
    // User has explicitly reconciled the hand-edit into the dashboard asset -
    // the notification correctly stops.
    expect(result.diff.handEditedComponentAssetIds).toEqual([]);
  });

  it('does not report an ordinary (never-hand-edited) component regardless of edited_externally', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const comp = await assetService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'hero', prompt: 'hero', imagePath: 'a.html', outputKind: 'component' });
    const page = await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    await pageService.update(page.id, { componentAssetIds: JSON.stringify([comp.id]) });

    await fsPromises.mkdir(path.join(exportDir, 'components'), { recursive: true });
    const tsx = 'export function HeroAAA111() { return <div />; }';
    const css = '.root {}';
    await fsPromises.writeFile(path.join(exportDir, 'components', 'HeroAAA111.tsx'), tsx);
    await fsPromises.writeFile(path.join(exportDir, 'components', 'HeroAAA111.module.css'), css);

    // handEdited is absent (ordinary, freshly-generated entry) and hashes match.
    await writeManifest(exportDir, {
      styleId: style.id, exportedAt: Date.now(),
      pages: [{ id: page.id, name: 'Home', slug: '', componentAssetIds: [comp.id], pageFileHash: 'irrelevant' }],
      components: [{ assetId: comp.id, componentName: 'HeroAAA111', contentHash: hashContent(tsx + '\n' + css) }],
    });
    await fsPromises.writeFile(path.join(exportDir, 'app', 'page.tsx'), pageFileContent(page.id, '      <HeroAAA111 />'));

    const result = await computeSyncDiff(style.id, exportDir);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.diff.handEditedComponentAssetIds).toEqual([]);
  });

  it('drops a component reference whose asset was soft-deleted after export, and reports it', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const compA = await assetService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'navbar', prompt: 'nav', imagePath: 'a.html', outputKind: 'component' });
    const compB = await assetService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'hero', prompt: 'hero', imagePath: 'b.html', outputKind: 'component' });
    const page = await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    await pageService.update(page.id, { componentAssetIds: JSON.stringify([compA.id, compB.id]) });
    await assetService.softDelete(compB.id, 'user-1');

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
