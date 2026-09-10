import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { pageService } from '@/lib/services/PageService';
import { assetService } from '@/lib/services/AssetService';
import { readManifest, hashContent, type ExportManifest } from '@/lib/services/ExportManifest';
import { slugify } from '@/lib/services/SiteExporter';

export interface SyncNewPage {
  slug: string;
  name: string;
  componentAssetIds: string[];
}

export interface SyncPageOrderChange {
  pageId: string;
  newComponentAssetIds: string[];
}

export interface SyncDiff {
  newPages: SyncNewPage[];
  deletedPageIds: string[];
  pageOrderChanges: SyncPageOrderChange[];
  handEditedComponentAssetIds: string[];
  droppedDeletedAssetIds: string[];
  conflictedPageIds: string[];
  notImportableFolders: string[];
}

export type SyncDiffResult =
  | { success: true; diff: SyncDiff }
  | { success: false; error: string };

// SiteExporter's buildPageFile() always writes this comment as the file's
// literal first line - nothing precedes it, not even a blank line or BOM.
// So anchoring to absolute string-start (^ without the `m` flag) is both
// sufficient for every legitimate file and a correct rejection of a fake
// copy of this text appearing anywhere else in a hand-written page.tsx
// (e.g. inside a multi-line template literal). The `m` flag must NOT be
// used here: it makes `^` match after ANY newline in the string, not just
// true position 0, so a fake comment on its own line inside a multi-line
// template literal would still match - identical to the unanchored bug
// this regex exists to fix.
const PAGE_ID_COMMENT_RE = /^\/\/ gameforge-page-id: ([0-9a-f-]+)/;

function slugToName(slug: string): string {
  if (!slug) return 'Home';
  return slug.split('-').filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// A route folder is only safe to adopt as a brand-new page if its slug is
// exactly what GameForge's own slugify() would produce - i.e. already
// canonical. Anything else (underscores, route groups like "(marketing)",
// dynamic segments like "[slug]", uppercase, stray hyphens) was never
// written by GameForge's exporter, so it must not be silently adopted:
// the NEXT export would then write a fresh canonically-named folder for it
// without ever removing the original, non-canonical one, which would keep
// re-triggering "new page" detection forever.
function isImportableSlug(slug: string): boolean {
  return slug === '' || slugify(slug) === slug;
}

function extractComponentTagOrder(pageFileContent: string, knownComponentNames: Set<string>): string[] {
  const found: string[] = [];
  const re = /<([A-Z][A-Za-z0-9]*)\b[^>]*\/>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(pageFileContent)) !== null) {
    if (knownComponentNames.has(match[1])) found.push(match[1]);
  }
  return found;
}

async function findRouteFolders(exportDir: string): Promise<Array<{ slug: string; pageFilePath: string }>> {
  const appDir = path.join(exportDir, 'app');
  const routes: Array<{ slug: string; pageFilePath: string }> = [];

  const homePageFile = path.join(appDir, 'page.tsx');
  try {
    await fsPromises.access(homePageFile);
    routes.push({ slug: '', pageFilePath: homePageFile });
  } catch {
    // No home page.tsx - unusual, but just means it's not present to scan.
  }

  let entries: fs.Dirent[];
  try {
    entries = await fsPromises.readdir(appDir, { withFileTypes: true });
  } catch (e) {
    console.error(`Failed to read export app directory ${appDir}:`, e);
    return routes;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pageFilePath = path.join(appDir, entry.name, 'page.tsx');
    try {
      await fsPromises.access(pageFilePath);
      routes.push({ slug: entry.name, pageFilePath });
    } catch {
      // Not a route folder (no page.tsx inside) - skip.
    }
  }
  return routes;
}

export async function computeSyncDiff(styleId: string, exportDir: string): Promise<SyncDiffResult> {
  const manifest = await readManifest(exportDir);
  if (!manifest || manifest.styleId !== styleId) {
    return { success: false, error: 'No GameForge export manifest found for this style in this directory. Export it from GameForge first.' };
  }

  const knownComponentNames = new Set(manifest.components.map(c => c.componentName));
  const componentNameToAssetId = new Map(manifest.components.map(c => [c.componentName, c.assetId]));

  // A component name resolves to a real asset ID only if that asset is still
  // active - a page.tsx can keep referencing a component whose asset was
  // soft-deleted from the dashboard after export, and that reference must be
  // dropped from the reconciled order (not silently kept), with the drop
  // reported in the diff rather than happening invisibly.
  const activeAssetIds = new Set<string>();
  for (const component of manifest.components) {
    const asset = await assetService.getById(component.assetId);
    if (asset && !asset.is_deleted) activeAssetIds.add(component.assetId);
  }
  const droppedDeletedAssetIds = new Set<string>();
  function resolveActiveAssetIds(tagNames: string[]): string[] {
    const resolved: string[] = [];
    for (const name of tagNames) {
      const assetId = componentNameToAssetId.get(name);
      if (!assetId) continue;
      if (!activeAssetIds.has(assetId)) {
        droppedDeletedAssetIds.add(assetId);
        continue;
      }
      resolved.push(assetId);
    }
    return resolved;
  }

  const routes = await findRouteFolders(exportDir);
  const routesById = new Map<string, { slug: string; pageFilePath: string; content: string }>();
  const newPages: SyncNewPage[] = [];
  const notImportableFolders: string[] = [];

  for (const route of routes) {
    let content: string;
    try {
      content = await fsPromises.readFile(route.pageFilePath, 'utf-8');
    } catch (e) {
      console.error(`Failed to read page file ${route.pageFilePath}:`, e);
      continue;
    }
    const idMatch = content.match(PAGE_ID_COMMENT_RE);
    if (idMatch) {
      routesById.set(idMatch[1], { ...route, content });
    } else if (!isImportableSlug(route.slug)) {
      notImportableFolders.push(route.slug);
    } else {
      const tagNames = extractComponentTagOrder(content, knownComponentNames);
      newPages.push({
        slug: route.slug,
        name: slugToName(route.slug),
        componentAssetIds: resolveActiveAssetIds(tagNames),
      });
    }
  }

  const deletedPageIds: string[] = [];
  const pageOrderChanges: SyncPageOrderChange[] = [];
  const conflictedPageIds: string[] = [];
  const currentPages = await pageService.getActivePagesForStyle(styleId);
  const currentPagesById = new Map(currentPages.map(p => [p.id, p]));

  for (const manifestPage of manifest.pages) {
    const route = routesById.get(manifestPage.id);
    const currentPage = currentPagesById.get(manifestPage.id);
    if (!route) {
      if (currentPage) deletedPageIds.push(manifestPage.id);
      continue;
    }
    if (!currentPage) continue; // page was already soft-deleted in the DB independently of export - nothing to reconcile
    const tagNames = extractComponentTagOrder(route.content, knownComponentNames);
    const diskOrder = resolveActiveAssetIds(tagNames);
    const currentOrder: string[] = JSON.parse(currentPage.component_asset_ids);
    const ancestorOrder = manifestPage.componentAssetIds;

    // Real 3-way diff against the ancestor order recorded at export time -
    // comparing disk directly against current (the old logic) falsely
    // flagged a dashboard-only reorder as "changed on disk", because disk
    // still holds the stale exported order. The ancestor is what tells us
    // which side, if either, actually moved since export.
    const diskMatchesAncestor = JSON.stringify(diskOrder) === JSON.stringify(ancestorOrder);
    const currentMatchesAncestor = JSON.stringify(currentOrder) === JSON.stringify(ancestorOrder);
    if (diskMatchesAncestor) {
      // Disk unchanged since export. If current also matches, nothing
      // changed anywhere; if current differs, that's the dashboard's own
      // edit - either way, disk has nothing to contribute. Not a sync-able
      // change and not a conflict.
      continue;
    }
    if (currentMatchesAncestor) {
      // Only disk changed since export - the original, intended case.
      pageOrderChanges.push({ pageId: manifestPage.id, newComponentAssetIds: diskOrder });
      continue;
    }
    // Both sides changed independently since export. If they converged on
    // the same order there's nothing to do; if they disagree, this is a
    // genuine conflict that must not be silently resolved either way.
    if (JSON.stringify(diskOrder) !== JSON.stringify(currentOrder)) {
      conflictedPageIds.push(manifestPage.id);
    }
  }

  const handEditedComponentAssetIds: string[] = [];
  for (const component of manifest.components) {
    const tsxPath = path.join(exportDir, 'components', `${component.componentName}.tsx`);
    const cssPath = path.join(exportDir, 'components', `${component.componentName}.module.css`);
    try {
      const [tsx, css] = await Promise.all([
        fsPromises.readFile(tsxPath, 'utf-8'),
        fsPromises.readFile(cssPath, 'utf-8'),
      ]);
      const onDiskHash = hashContent(tsx + '\n' + css);
      if (onDiskHash !== component.contentHash) {
        handEditedComponentAssetIds.push(component.assetId);
      }
    } catch (e: any) {
      if (e?.code !== 'ENOENT') {
        console.error(`Failed to read on-disk component files for ${component.componentName}:`, e);
      }
      // Missing entirely (ENOENT) is not treated as a hand-edit here; it
      // will simply no longer appear in any page's tag scan above.
    }
  }

  return {
    success: true,
    diff: { newPages, deletedPageIds, pageOrderChanges, handEditedComponentAssetIds, droppedDeletedAssetIds: [...droppedDeletedAssetIds], conflictedPageIds, notImportableFolders },
  };
}
