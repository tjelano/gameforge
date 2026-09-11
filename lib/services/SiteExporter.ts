import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { pageService } from '@/lib/services/PageService';
import { assetService } from '@/lib/services/AssetService';
import { parseComponentHtml } from '@/lib/services/componentDocument';
import { sanitizeComponentHtml, sanitizeComponentCss } from '@/lib/services/componentSanitize';
import { parseThemeCss } from '@/lib/services/ThemeGenerator';
import { tokensToTailwindTheme } from '@/lib/services/themeExport/tailwindExporter';
import { htmlToJsx, escapeJsxText } from '@/lib/services/siteExportDocument';
import { scopeComponentCss } from '@/lib/services/pageDocument';
import { hashContent, readManifest, writeManifest, type ExportManifest } from '@/lib/services/ExportManifest';
import type { Page, Asset } from '@/lib/database/schema';

// The literal CSS-Module class name every component's wrapper element
// carries - a fixed, predictable name is fine since it's scoped to that
// one component's own .module.css file (no cross-component collision
// risk; CSS Modules hashes it uniquely per file regardless).
const COMPONENT_SCOPE_CLASS = 'root';

const LOCK_STALE_MS = 2 * 60 * 1000; // no heartbeat for this long => treat as crashed
const HEARTBEAT_INTERVAL_MS = 30 * 1000;

interface ExportLock {
  release(): Promise<void>;
}

async function writeHeartbeat(lockDir: string): Promise<void> {
  await fsPromises.writeFile(path.join(lockDir, 'heartbeat'), String(Date.now()));
}

async function isLockStale(lockDir: string): Promise<boolean> {
  try {
    const raw = await fsPromises.readFile(path.join(lockDir, 'heartbeat'), 'utf-8');
    const last = Number(raw);
    return !Number.isFinite(last) || Date.now() - last > LOCK_STALE_MS;
  } catch (e: any) {
    if (e?.code === 'ENOENT') {
      // No heartbeat file. Could be a lock claimed moments ago (the narrow
      // window before its first writeHeartbeat call - stat's mtime will be
      // very recent, correctly NOT stale below) or a lock whose heartbeat
      // vanished some other way (e.g. a crash mid-release(), between the
      // heartbeat file's removal and the directory's own removal completing).
      // Fall back to the directory's own mtime so a genuinely old,
      // heartbeat-less lock still eventually gets recovered instead of
      // blocking every future export of this subdir forever.
      try {
        const stat = await fsPromises.stat(lockDir);
        return Date.now() - stat.mtimeMs > LOCK_STALE_MS;
      } catch {
        // Directory itself is gone by the time we got here (released
        // concurrently) - not our problem to resolve; the caller's own
        // tryClaim()/tryRecoverStaleLock() retry logic handles this.
        return false;
      }
    }
    // Anything else (e.g. EACCES) is unexpected - still treat conservatively
    // as not-stale (never seize a lock we can't actually confirm is dead),
    // but log it, since a persistent read failure here would otherwise look
    // identical to a healthy, freshly-claimed lock forever.
    console.error(`Failed to read heartbeat for export lock ${lockDir}, treating as not stale:`, e);
    return false;
  }
}

/**
 * Atomically claims a stale lock by renaming it away first - remove-then-mkdir
 * is NOT atomic as a unit and lets two contenders both "win" a stale lock at
 * once. Only the contender whose rename succeeds may proceed to create a
 * fresh lock; a second contender's rename fails with ENOENT (the path is
 * already gone) and it must back off normally.
 */
async function tryRecoverStaleLock(lockDir: string): Promise<boolean> {
  const garbageDir = `${lockDir}.stale.${process.pid}`;
  try {
    await fsPromises.rename(lockDir, garbageDir);
  } catch (e: any) {
    // On Windows (this project's own dev/deploy platform), the loser of a
    // race to rename the SAME source directory gets EPERM, not the
    // POSIX-typical ENOENT - confirmed by actually reproducing it under two
    // real concurrent exportSite() calls racing the same stale lock
    // (test/siteExporterLock.test.ts's stale-lock-recovery-race test failed
    // intermittently with exactly this: "EPERM: operation not permitted,
    // rename '...\my-site.lock' -> '...\my-site.lock.stale.<pid>'" before
    // this branch was added), not just inferred from docs. Both codes mean
    // the same thing here - someone else's rename already won - so back off
    // normally instead of surfacing an unhandled error from a benign race.
    if (e?.code === 'ENOENT' || e?.code === 'EPERM') return false;
    console.error(`Failed to claim stale export lock ${lockDir}:`, e);
    throw e;
  }
  fsPromises.rm(garbageDir, { recursive: true, force: true }).catch(e => {
    console.error(`Failed to clean up stale export lock remnant ${garbageDir}:`, e);
  });
  return true;
}

async function acquireExportLock(exportsRootDir: string, subdir: string): Promise<ExportLock> {
  const locksDir = path.join(exportsRootDir, '.locks');
  try {
    await fsPromises.mkdir(locksDir, { recursive: true });
  } catch (e) {
    console.error(`Failed to create the export locks directory ${locksDir}:`, e);
    throw e;
  }
  const lockDir = path.join(locksDir, `${subdir}.lock`);

  async function tryClaim(): Promise<boolean> {
    try {
      await fsPromises.mkdir(lockDir);
      return true;
    } catch (e: any) {
      if (e?.code !== 'EEXIST') {
        console.error(`Failed to create export lock directory ${lockDir}:`, e);
        throw e;
      }
      return false;
    }
  }

  let claimed = await tryClaim();
  if (!claimed && await isLockStale(lockDir)) {
    if (await tryRecoverStaleLock(lockDir)) {
      claimed = await tryClaim();
    }
  }
  if (!claimed) {
    throw new Error('EXPORT_IN_PROGRESS');
  }

  // A failure anywhere in here (e.g. a transient ENOSPC/EMFILE on the
  // initial heartbeat write) must not leave lockDir behind with no
  // heartbeat file and no live process to ever release it - that would
  // orphan the lock permanently, since isLockStale() treats a missing
  // heartbeat file as "brand new, not stale" (see its own comment above)
  // rather than "crashed". Best-effort remove the lock we just claimed
  // before rethrowing, so a future caller can claim it fresh instead of
  // getting EXPORT_IN_PROGRESS forever.
  let heartbeatTimer: NodeJS.Timeout;
  try {
    await writeHeartbeat(lockDir);
    heartbeatTimer = setInterval(() => {
      writeHeartbeat(lockDir).catch(e => console.error(`Failed to refresh export lock heartbeat for ${subdir}:`, e));
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref();
  } catch (e) {
    console.error(`Failed to initialize export lock heartbeat for ${lockDir}, releasing the lock:`, e);
    fsPromises.rm(lockDir, { recursive: true, force: true }).catch(cleanupErr => {
      console.error(`Failed to clean up export lock directory ${lockDir} after a failed heartbeat write:`, cleanupErr);
    });
    throw e;
  }

  return {
    async release() {
      clearInterval(heartbeatTimer);
      try {
        await fsPromises.rm(lockDir, { recursive: true, force: true });
      } catch (e) {
        console.error(`Failed to remove export lock directory ${lockDir}:`, e);
      }
    },
  };
}

/**
 * Read-only check for callers that don't want to hold the lock themselves
 * (the sync preview/apply routes) - they just need to avoid racing a
 * re-export that's actively in flight. Mirrors acquireExportLock's own
 * staleness logic exactly (including the mtime fallback for a missing
 * heartbeat file), so it never reports a truly-dead lock as "in progress."
 */
export async function isExportInProgress(subdir: string): Promise<boolean> {
  const lockDir = path.join(getProjectRoot(), 'storage', 'exports', '.locks', `${subdir}.lock`);
  try {
    await fsPromises.access(lockDir);
  } catch {
    return false;
  }
  return !(await isLockStale(lockDir));
}

export interface SiteExportResult {
  pagesExported: number;
  componentsExported: number;
  targetDir: string;
  skippedComponents: string[];
  skippedPages: string[];
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// asset_type is free text typed by the user (PresetForm.tsx's "component
// type" field is a plain <input>, not a dropdown) - it can contain
// anything, including characters that are NOT safe in a JS identifier or
// a Windows filename. Two real, verified failure modes if this only
// stripped separator characters (a "-"/"_"/whitespace-only replace,
// which was this plan's own earlier, buggy draft):
//   1. A name starting with a digit after stripping (e.g. "2-column
//      footer" -> "2ColumnFooter") produces an invalid JS identifier -
//      confirmed with a real tsc compile: TS1003/TS1005/TS1351.
//   2. A name containing a colon (e.g. "FAQ: how it works") is even
//      worse on Windows (this project's own dev platform): a colon in a
//      filename doesn't throw on write - NTFS silently treats it as an
//      Alternate-Data-Stream separator, so fs.writeFile "succeeds" but
//      creates a 0-byte file with the real content hidden in an
//      invisible stream. Confirmed with a real fs.writeFileSync test.
// The fix: strip EVERYTHING outside [A-Za-z0-9] (not just common
// separators), and guard against a leading digit explicitly.
function pascalCase(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const pascal = words.map(word => word.charAt(0).toUpperCase() + word.slice(1)).join('');
  if (!pascal) return 'Component';
  return /^[0-9]/.test(pascal) ? `C${pascal}` : pascal;
}

function componentName(asset: Asset): string {
  return `${pascalCase(asset.asset_type)}${asset.id.replace(/-/g, '').slice(0, 6)}`;
}

interface ConvertedComponent {
  asset: Asset;
  componentName: string;
  jsx: string;
  css: string;
}

// Mirrors the route's own Zod validation - re-checked here too so this
// public method is safe regardless of caller (the route is the only
// current caller, but a future direct caller - a script, a test, another
// route - must not be able to bypass this and path-traverse via subdir).
const SUBDIR_PATTERN = /^[a-z0-9-]+$/;

class SiteExporterImpl {
  async exportSite(styleId: string, subdir: string): Promise<SiteExportResult | { error: 'NOTHING_TO_EXPORT' | 'ALREADY_EXISTS' | 'INVALID_SUBDIR' | 'EXPORT_IN_PROGRESS' }> {
    if (!SUBDIR_PATTERN.test(subdir)) {
      return { error: 'INVALID_SUBDIR' };
    }

    const exportsRootDir = path.join(getProjectRoot(), 'storage', 'exports');
    try {
      // Defensive - don't depend on setup.sh/setup.bat having created this
      // parent dir already, matches GitService.ensureDirectoriesExist()'s
      // own defensive mkdir pattern for storage/images etc.
      await fsPromises.mkdir(exportsRootDir, { recursive: true });
    } catch (e) {
      console.error(`Failed to create the exports root directory ${exportsRootDir}:`, e);
      throw e;
    }

    let lock: ExportLock;
    try {
      lock = await acquireExportLock(exportsRootDir, subdir);
    } catch (e: any) {
      if (e?.message === 'EXPORT_IN_PROGRESS') return { error: 'EXPORT_IN_PROGRESS' };
      throw e;
    }

    try {
      const pagesNewestFirst = await pageService.getActivePagesForStyle(styleId);
      if (pagesNewestFirst.length === 0) {
        return { error: 'NOTHING_TO_EXPORT' };
      }
      // getActivePagesForStyle returns newest-first (ORDER BY created_at
      // DESC) - reverse to oldest-first so pages[0] is the home page and
      // the nav lists pages in creation order.
      const pages: Page[] = [...pagesNewestFirst].reverse();

      const targetDir = path.join(getProjectRoot(), 'storage', 'exports', subdir);
      let existingManifest: ExportManifest | null = null;
      try {
        // A single atomic mkdir (non-recursive) IS the existence check - it
        // either creates targetDir and we own it, or fails with EEXIST because
        // someone else's request already created it. This closes a real race:
        // the previous check (fsPromises.access, then a *recursive* mkdir much
        // later) had a window where two concurrent exports of the same subdir
        // could both pass the access check - recursive:true never throws EEXIST
        // even if targetDir now exists - and interleave writes into one folder.
        await fsPromises.mkdir(targetDir);
      } catch (e: any) {
        if (e?.code !== 'EEXIST') {
          // Anything else (e.g. EACCES) is a real problem this must not
          // silently proceed past, since that would lead to a much less clear
          // failure later (a raw mkdir/writeFile error) instead of surfacing
          // the real cause here.
          console.error(`Failed to create export target directory ${targetDir}:`, e);
          throw e;
        }
        // The directory already exists - this is only a legitimate re-export if
        // it's one GameForge made for this exact style. Anything else (an
        // unrelated directory, or another style's export reusing this subdir
        // name) must not be silently written into.
        existingManifest = await readManifest(targetDir);
        if (!existingManifest || existingManifest.styleId !== styleId) {
          return { error: 'ALREADY_EXISTS' };
        }
      }

      const componentsByAssetId = new Map<string, ConvertedComponent>();
      const pageComponentNames: string[][] = [];

      for (const page of pages) {
        const assetIds = JSON.parse(page.component_asset_ids) as string[];
        const namesForThisPage: string[] = [];
        for (const assetId of assetIds) {
          if (!componentsByAssetId.has(assetId)) {
            const converted = await this.convertComponent(assetId, page.id);
            if (!converted) continue;
            componentsByAssetId.set(assetId, converted);
          }
          namesForThisPage.push(componentsByAssetId.get(assetId)!.componentName);
        }
        pageComponentNames.push(namesForThisPage);
      }

      const components = [...componentsByAssetId.values()];
      const skippedComponents: string[] = [];
      // Records the actual on-disk hash for a skipped (hand-edited) component,
      // so the manifest written below can preserve "the last observed/accepted
      // state" instead of "what GameForge would ideally generate" - otherwise
      // a hand-edit gets flagged forever, since regenerated code never
      // byte-matches hand-written code. See componentName -> onDiskHash below.
      const manifestHashOverrides = new Map<string, string>();

      const skippedPages: string[] = [];

      // Same hash-check-and-skip pattern as the component loop above, applied
      // to page files: only overwrite a page.tsx if its on-disk content still
      // matches what GameForge itself last wrote there (per the PRIOR
      // manifest) - anything else means a human touched it since, and it
      // must not be silently clobbered. Deliberately simpler than the
      // component version (no handEdited/accepted-baseline concept): pages
      // have no explicit "accept this edit" action, so an unreverted
      // hand-edit just stays flagged on every future export - safe, just
      // not self-clearing.
      const writePageIfUnedited = async (pageId: string, pageFile: string, pageFilePath: string): Promise<void> => {
        const priorEntry = existingManifest?.pages.find(p => p.id === pageId);
        if (priorEntry) {
          let onDiskHash: string | null = null;
          try {
            onDiskHash = hashContent(await fsPromises.readFile(pageFilePath, 'utf-8'));
          } catch (e: any) {
            if (e?.code !== 'ENOENT') {
              console.error(`Failed to read on-disk page ${pageId} for hand-edit check:`, e);
            }
          }
          if (onDiskHash !== null && onDiskHash !== priorEntry.pageFileHash) {
            skippedPages.push(pageId);
            return;
          }
        }
        await fsPromises.writeFile(pageFilePath, pageFile);
      };

      try {
        await fsPromises.mkdir(path.join(targetDir, 'app'), { recursive: true });
        await fsPromises.mkdir(path.join(targetDir, 'components'), { recursive: true });

        for (const component of components) {
          const priorEntry = existingManifest?.components.find(c => c.assetId === component.asset.id);
          // A hand-edit is detected by comparing the CURRENT ON-DISK file against
          // what the manifest last recorded as GameForge's own expected content
          // for this component - not against what we're about to write now. If
          // they differ, someone changed the file since the last export/sync and
          // it must not be silently overwritten.
          if (priorEntry) {
            const tsxPath = path.join(targetDir, 'components', `${component.componentName}.tsx`);
            const cssPath = path.join(targetDir, 'components', `${component.componentName}.module.css`);
            let onDiskHash: string | null = null;
            try {
              const [tsx, css] = await Promise.all([
                fsPromises.readFile(tsxPath, 'utf-8'),
                fsPromises.readFile(cssPath, 'utf-8'),
              ]);
              onDiskHash = hashContent(tsx + '\n' + css);
            } catch (e: any) {
              // ENOENT (files don't exist on disk, e.g. deleted by hand) is
              // the expected case - nothing to preserve, safe to write fresh
              // below. Anything else (e.g. EACCES) must not vanish silently.
              if (e?.code !== 'ENOENT') {
                console.error(`Failed to read on-disk component ${component.componentName} for hand-edit check:`, e);
              }
            }
            if (onDiskHash !== null && onDiskHash !== priorEntry.contentHash) {
              // Genuinely new divergence from whatever was last recorded
              // (GameForge's own generated content, or a previously-accepted
              // hand-edit baseline) - preserve it on disk and (re)flag it.
              skippedComponents.push(component.componentName);
              manifestHashOverrides.set(component.componentName, onDiskHash);
              continue;
            }
            if (onDiskHash !== null && priorEntry.handEdited) {
              // Matches the previously-accepted hand-edited baseline exactly
              // (nothing changed since it was accepted) - do NOT fall through
              // to the unconditional regenerate-and-write below, or this
              // would silently overwrite the accepted hand-edit with fresh
              // ideal content on the very next export. Carry the same hash
              // forward (still hand-edited) without re-flagging it.
              manifestHashOverrides.set(component.componentName, onDiskHash);
              continue;
            }
          }
          await fsPromises.writeFile(
            path.join(targetDir, 'components', `${component.componentName}.tsx`),
            this.buildComponentFile(component)
          );
          await fsPromises.writeFile(
            path.join(targetDir, 'components', `${component.componentName}.module.css`),
            component.css
          );
        }

        const themeCss = await assetService.loadThemeCssForStyle(styleId);
        let themeBlock = '';
        if (themeCss) {
          try {
            themeBlock = tokensToTailwindTheme(parseThemeCss(themeCss));
          } catch (e) {
            console.error(`Could not convert theme CSS to Tailwind theme for style ${styleId}, exporting without it:`, e);
          }
        }
        await fsPromises.writeFile(
          path.join(targetDir, 'app', 'globals.css'),
          `@import "tailwindcss";\n\n${themeBlock}${this.buildThemeAliasBlock(themeBlock)}`
        );

        const manifestPages: ExportManifest['pages'] = [];

        const slugs = this.buildPageSlugs(pages);
        await fsPromises.writeFile(path.join(targetDir, 'app', 'layout.tsx'), this.buildLayoutFile(pages, slugs));

        const homePageFile = this.buildPageFile(pages[0], pageComponentNames[0], components);
        await writePageIfUnedited(pages[0].id, homePageFile, path.join(targetDir, 'app', 'page.tsx'));
        manifestPages.push({
          id: pages[0].id,
          name: pages[0].name,
          slug: slugs[0],
          componentAssetIds: JSON.parse(pages[0].component_asset_ids),
          pageFileHash: hashContent(homePageFile),
        });

        for (let i = 1; i < pages.length; i++) {
          const pageDir = path.join(targetDir, 'app', slugs[i]);
          await fsPromises.mkdir(pageDir, { recursive: true });
          const pageFile = this.buildPageFile(pages[i], pageComponentNames[i], components);
          await writePageIfUnedited(pages[i].id, pageFile, path.join(pageDir, 'page.tsx'));
          manifestPages.push({
            id: pages[i].id,
            name: pages[i].name,
            slug: slugs[i],
            componentAssetIds: JSON.parse(pages[i].component_asset_ids),
            pageFileHash: hashContent(pageFile),
          });
        }

        await fsPromises.writeFile(path.join(targetDir, 'package.json'), this.buildPackageJson());
        await fsPromises.writeFile(path.join(targetDir, 'tsconfig.json'), this.buildTsConfig());
        await fsPromises.writeFile(path.join(targetDir, 'postcss.config.mjs'), this.buildPostcssConfig());

        const manifest: ExportManifest = {
          styleId,
          exportedAt: Date.now(),
          pages: manifestPages,
          components: components.map(c => ({
            assetId: c.asset.id,
            componentName: c.componentName,
            // A skipped (hand-edited) component preserves the accepted on-disk
            // hash instead of the freshly-generated one - see
            // manifestHashOverrides above.
            contentHash: manifestHashOverrides.get(c.componentName) ?? hashContent(this.buildComponentFile(c) + '\n' + c.css),
            handEdited: manifestHashOverrides.has(c.componentName),
          })),
        };
        await writeManifest(targetDir, manifest);
      } catch (e) {
        console.error(`Failed to write exported site files to ${targetDir}:`, e);
        throw e;
      }

      return { pagesExported: pages.length, componentsExported: components.length, targetDir, skippedComponents, skippedPages };
    } finally {
      await lock.release();
    }
  }

  private async convertComponent(assetId: string, pageId: string): Promise<ConvertedComponent | null> {
    try {
      const asset = await assetService.getById(assetId);
      if (!asset || asset.is_deleted || asset.output_kind !== 'component' || !asset.image_path) {
        console.error(`Page ${pageId} references a stale/invalid component asset ${assetId}, skipping`);
        return null;
      }
      const filename = asset.image_path;
      if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
        console.error(`Page ${pageId} references a component asset ${assetId} with an unsafe filename, skipping`);
        return null;
      }
      const document = await fsPromises.readFile(path.join(getProjectRoot(), 'storage', 'components', filename), 'utf-8');
      const tokens = parseComponentHtml(document);
      // An asset marked `edited_externally` already had its trust decision
      // made at WRITE time (PATCH .../component with trustAsEdited) — skip
      // only the sanitize calls for that case. scopeComponentCss/htmlToJsx
      // below still run unconditionally on whatever html/css result: they're
      // required format conversions for the export target, not sanitization.
      const trusted = asset.edited_externally === 1;
      const html = trusted ? tokens.html : sanitizeComponentHtml(tokens.html);
      // scopeComponentCss runs AFTER sanitization (it needs real, trusted
      // CSS to parse) and BEFORE this CSS is ever written to a
      // .module.css file. Next's CSS Modules compiler runs in "pure"
      // mode, which REJECTS any selector with no local class (confirmed
      // by actually running Next's own vendored
      // postcss-modules-local-by-default plugin: `button{}`, `a:hover{}`,
      // `*{}`, `:root{}` all fail; `.btn`, `.nav a` pass) -
      // sanitizeComponentCss validates functions/at-rules but never
      // selectors, so an LLM-emitted bare-tag/universal/pseudo-class rule
      // reaches here unchanged and would otherwise break the exported
      // project's build. Prefixing every selector with a real local
      // class (this function, reused unchanged from Page Composer's
      // already-shipped, already-tested scoping logic) is the ONLY
      // verified-working fix - wrapping bare selectors in `:global(...)`
      // does NOT work (confirmed by actually running the same real
      // compiler against that approach: :global() explicitly marks its
      // contents non-local, so the rule still has zero local selectors
      // and still fails identically). buildComponentFile below wraps the
      // component's JSX in a real element carrying this same scope
      // class, matching what this CSS now expects to be nested under.
      const css = scopeComponentCss(trusted ? tokens.css : sanitizeComponentCss(tokens.css), COMPONENT_SCOPE_CLASS);
      return { asset, componentName: componentName(asset), jsx: htmlToJsx(html), css };
    } catch (e) {
      console.error(`Failed to convert component asset ${assetId} for export, skipping:`, e);
      return null;
    }
  }

  private buildComponentFile(component: ConvertedComponent): string {
    // Wraps in a real element (not a bare Fragment) carrying the same
    // scope class scopeComponentCss prefixed every selector in this
    // component's CSS with - the wrapper is what makes ".root button"
    // (etc.) actually match something in the rendered DOM. A <div> is a
    // safe, neutral choice regardless of the component's own top-level
    // tag (nav/button/section/...): it adds no semantics of its own and
    // doesn't hide the wrapped element's own semantics from assistive
    // tech (e.g. a wrapped <nav> is still a real nav landmark).
    return `import styles from './${component.componentName}.module.css';

export function ${component.componentName}() {
  return (
    <div className={styles.${COMPONENT_SCOPE_CLASS}}>
${component.jsx}
    </div>
  );
}
`;
  }

  private buildPageSlugs(pages: Page[]): string[] {
    const used = new Set<string>();
    return pages.map((page, i) => {
      if (i === 0) return ''; // home page has no slug directory
      let slug = slugify(page.name) || 'page';
      if (used.has(slug)) {
        slug = `${slug}-${page.id.replace(/-/g, '').slice(0, 6)}`;
      }
      used.add(slug);
      return slug;
    });
  }

  private buildLayoutFile(pages: Page[], slugs: string[]): string {
    // page.name is free text (z.string().min(1), no character
    // restriction - app/api/styles/[id]/pages/route.ts) and must be
    // escaped the same way htmlToJsx escapes component text content: an
    // unescaped "<"/">"/"{"/"}" in a page name is a real tsc syntax
    // error (confirmed: TS17008 for an unclosed-looking "<Tag>" inside
    // raw JSX text), and this codebase's own domain (game asset naming,
    // e.g. "HP < 50%") makes such names plausible, not exotic.
    const links = pages.map((page, i) => {
      const href = i === 0 ? '/' : `/${slugs[i]}`;
      return `        <a href="${href}">${escapeJsxText(page.name)}</a>`;
    }).join('\n');
    return `import './globals.css';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav style={{ display: 'flex', gap: 16, padding: 16 }}>
${links}
        </nav>
        {children}
      </body>
    </html>
  );
}
`;
  }

  private buildPageFile(page: Page, componentNames: string[], allComponents: ConvertedComponent[]): string {
    const usedComponents = allComponents.filter(c => componentNames.includes(c.componentName));
    const imports = usedComponents.map(c => `import { ${c.componentName} } from '@/components/${c.componentName}';`).join('\n');
    const elements = componentNames.map(name => `      <${name} />`).join('\n');
    return `// gameforge-page-id: ${page.id}
${imports}

export default function Page() {
  return (
    <>
${elements}
    </>
  );
}
`;
  }

  // Confirmed against Tailwind v4's own Next.js setup guide: @import
  // "tailwindcss" alone does nothing without @tailwindcss/postcss wired
  // into a postcss.config.mjs (see buildPostcssConfig below) - without
  // it, Next.js never runs Tailwind's PostCSS transform at all, so the
  // @theme block in globals.css passes through as literal, unrecognized
  // CSS and every token in it is silently dropped by the browser.
  // Confirmed by actually running the exported project and inspecting
  // the served CSS, not just by reading Tailwind's docs.
  private buildPackageJson(): string {
    return JSON.stringify({
      name: 'exported-site',
      version: '0.1.0',
      private: true,
      scripts: {
        dev: 'next dev',
        build: 'next build',
        start: 'next start',
      },
      dependencies: {
        next: '^16.3.4',
        react: '^19.1.0',
        'react-dom': '^19.1.0',
        tailwindcss: '^4.0.0',
      },
      devDependencies: {
        typescript: '^5.7.2',
        '@types/react': '^19.0.0',
        '@types/react-dom': '^19.0.0',
        '@types/node': '^24.0.0',
        postcss: '^8.5.28',
        '@tailwindcss/postcss': '^4.0.0',
      },
    }, null, 2);
  }

  private buildPostcssConfig(): string {
    return `const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
`;
  }

  // tokensToTailwindTheme (themeExport/tailwindExporter.ts) is shared with
  // the single-asset "download as Tailwind CSS" export route, which
  // deliberately uses Tailwind's own idiomatic variable names
  // (--color-background/--color-foreground/--spacing) so utilities like
  // bg-background generate for a user pasting the file into their own
  // Tailwind project - that contract has its own test
  // (test/assetExportRoute.test.ts) and must not change here.
  // But every real component's CSS (MockComponentGenerator.ts, and the
  // LLM tool-schema description in ComponentGenerator.ts) references the
  // PRE-EXISTING GameForge variable names instead: --color-bg, --color-fg,
  // --space-unit (colorAccent/colorBorder/fontHeading/fontBody/radiusBase
  // already match by coincidence). SiteExporter copies that component CSS
  // into the exported project verbatim, unrenamed - so without this alias
  // block, every exported component's background, text color, and
  // padding/margin/gap silently resolve to nothing. Confirmed by actually
  // exporting a themed style, running the exported project, and observing
  // an unstyled page - not just by reading the two files side by side.
  private buildThemeAliasBlock(themeBlock: string): string {
    if (!themeBlock) return '';
    return `:root {
  --color-bg: var(--color-background);
  --color-fg: var(--color-foreground);
  --space-unit: var(--spacing);
}
`;
  }

  private buildTsConfig(): string {
    return JSON.stringify({
      compilerOptions: {
        target: 'ES2017',
        lib: ['dom', 'dom.iterable', 'esnext'],
        allowJs: true,
        skipLibCheck: true,
        strict: true,
        noEmit: true,
        esModuleInterop: true,
        module: 'esnext',
        moduleResolution: 'bundler',
        resolveJsonModule: true,
        isolatedModules: true,
        jsx: 'preserve',
        incremental: true,
        paths: { '@/*': ['./*'] },
      },
      include: ['**/*.ts', '**/*.tsx'],
      exclude: ['node_modules'],
    }, null, 2);
  }
}

export const siteExporter = new SiteExporterImpl();
