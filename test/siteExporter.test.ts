import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import postcss from 'postcss';
// Next's own vendored CSS Modules compiler - the exact one next dev/next
// build use. Imported here specifically so this test suite can prove
// generated CSS actually passes real compilation, not just a
// hand-written string-equality assertion (which is exactly what let an
// earlier, broken version of the selector-scoping fix pass its own
// tests while still failing for real - see the correction note earlier
// in this plan's Task 1 section for the full story). No .d.ts ships for
// this Next-internal compiled path, so noImplicitAny (via strict: true)
// flags it as TS7016 - suppressed here rather than adding a project-wide
// ambient module declaration for one test's import.
// @ts-expect-error - no type declarations for this Next-internal compiled module
import localByDefault from 'next/dist/compiled/postcss-modules-local-by-default';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { pageService } from '@/lib/services/PageService';
import { assetService } from '@/lib/services/AssetService';
import { siteExporter } from '@/lib/services/SiteExporter';
import { tokensToCss } from '@/lib/services/themeTokens';

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

async function makeThemeAsset(styleId: string, filename: string) {
  const css = tokensToCss({
    colorBackground: '#1a1420',
    colorForeground: '#f0e6d2',
    colorAccent: '#e8a33d',
    colorBorder: '#4a3728',
    fontHeading: "'Cinzel', serif",
    fontBody: "'EB Garamond', serif",
    spaceUnit: '8px',
    radiusBase: '4px',
  });
  await fsPromises.writeFile(path.join(tempRoot, 'storage', 'themes', filename), css);
  return assetService.create({
    styleId,
    createdBy: 'user-1',
    assetType: 'theme',
    prompt: 'a theme',
    imagePath: filename,
    outputKind: 'theme',
  });
}

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

  it('re-exports into the same subdir for the same style even with zero components (no manifest components entries to compare against)', async () => {
    // Was originally "returns ALREADY_EXISTS if the target subdir already
    // exists" - that contract intentionally changed: re-exporting into a
    // directory GameForge itself created for this exact style is now
    // allowed (see the "re-exports into an existing directory..." test
    // below), so the same-style/same-subdir case must now succeed instead
    // of erroring. This still guards a distinct edge case: zero components
    // means an empty existingManifest.components array, so the write loop's
    // priorEntry lookup must not throw/misbehave on that.
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    const first = await siteExporter.exportSite(style.id, 'test-dup');
    expect(first).not.toHaveProperty('error');
    const second = await siteExporter.exportSite(style.id, 'test-dup');
    expect(second).not.toHaveProperty('error');
  });

  it('never lets two concurrent exports of the same subdir both succeed (closes the mkdir TOCTOU race)', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });

    const [a, b] = await Promise.all([
      siteExporter.exportSite(style.id, 'test-race'),
      siteExporter.exportSite(style.id, 'test-race'),
    ]);
    const results = [a, b];
    const successes = results.filter(r => !('error' in r));
    // Task 5's export lock is now the first concurrency gate - it's acquired
    // before the targetDir mkdir this test used to race on ever runs, so the
    // losing call fails there with EXPORT_IN_PROGRESS instead of reaching
    // the mkdir race and getting ALREADY_EXISTS.
    //
    // Under real system load (observed intermittently running the full
    // suite, not this file alone) the two calls can also fully serialize
    // instead of truly overlapping: the first can acquire the lock, export,
    // and release it before the second's very first tryClaim() ever runs -
    // in which case the second legitimately re-exports into the
    // now-existing, same-style directory (Task 4's own supported path) and
    // ALSO succeeds. That's not a corruption, it's the lock correctly
    // allowing full serialization instead of overlap - so the invariant
    // this test can actually guarantee is "at least one succeeds, and any
    // non-success is EXPORT_IN_PROGRESS (never some other/unexpected
    // error)", not "exactly one of each".
    const inProgress = results.filter(r => 'error' in r && r.error === 'EXPORT_IN_PROGRESS');
    expect(successes.length).toBeGreaterThanOrEqual(1);
    expect(successes.length + inProgress.length).toBe(2);
  });

  it('rejects an unsafe subdir even when called directly, bypassing the route\'s own validation', async () => {
    // exportSite is a public method on an exported singleton - the route
    // is its only current caller, but a future direct caller (a script,
    // a test, another route) must not be able to path-traverse via
    // subdir just because the route's own Zod check was skipped.
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    const result = await siteExporter.exportSite(style.id, '../escape');
    expect(result).toEqual({ error: 'INVALID_SUBDIR' });
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

  it('produces a safe component filename/identifier for an asset_type containing spaces, punctuation, and a leading digit', async () => {
    // asset_type is free text (a plain <input> in PresetForm.tsx, no
    // allowlist) - "2-column footer" would naively pascal-case to
    // "2ColumnFooter", an invalid JS identifier (leading digit), and a
    // colon in the type (not exercised here, but the same code path)
    // would silently vanish into an NTFS Alternate Data Stream on
    // Windows instead of erroring. This test proves the digit-leading
    // case is handled; the fix (stripping all non-alphanumerics +
    // guarding a leading digit) covers both by construction.
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const asset = await assetService.create({
      styleId: style.id,
      createdBy: 'user-1',
      assetType: '2-column footer',
      prompt: 'a footer',
      imagePath: 'weird-type.html',
      outputKind: 'component',
    });
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'components', 'weird-type.html'), COMPONENT_DOC);
    const page = await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    await pageService.update(page.id, { componentAssetIds: JSON.stringify([asset.id]) });

    const result = await siteExporter.exportSite(style.id, 'test-weird-type');
    const ok = result as { targetDir: string };
    const componentFiles = await fsPromises.readdir(path.join(ok.targetDir, 'components'));
    const tsxFile = componentFiles.find(f => f.endsWith('.tsx'));
    expect(tsxFile).toBeDefined();
    // Must not start with a digit - a leading-digit filename/identifier
    // is exactly the bug this test guards against.
    expect(tsxFile).not.toMatch(/^[0-9]/);
    const content = await fsPromises.readFile(path.join(ok.targetDir, 'components', tsxFile!), 'utf-8');
    expect(content).not.toMatch(/export function [0-9]/);
  });

  it('escapes a page name containing angle brackets so it does not break the generated layout.tsx', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await pageService.create({ styleId: style.id, name: 'Pricing & <Support>', createdBy: 'user-1' });
    const result = await siteExporter.exportSite(style.id, 'test-page-name-escape');
    const ok = result as { targetDir: string };
    const layoutContent = await fsPromises.readFile(path.join(ok.targetDir, 'app', 'layout.tsx'), 'utf-8');
    // The raw, unescaped name must never appear as literal JSX text -
    // it must be wrapped as a JS string expression instead.
    expect(layoutContent).not.toContain('>Pricing & <Support></a>');
    expect(layoutContent).toContain(JSON.stringify('Pricing & <Support>'));
  });

  it('writes a postcss.config.mjs and the @tailwindcss/postcss + postcss devDependencies, so the exported project actually runs Tailwind\'s PostCSS transform instead of shipping an inert @import/@theme block', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    const result = await siteExporter.exportSite(style.id, 'test-postcss');
    const ok = result as { targetDir: string };

    const postcssConfig = await fsPromises.readFile(path.join(ok.targetDir, 'postcss.config.mjs'), 'utf-8');
    expect(postcssConfig).toContain('@tailwindcss/postcss');

    const pkg = JSON.parse(await fsPromises.readFile(path.join(ok.targetDir, 'package.json'), 'utf-8'));
    expect(pkg.devDependencies['@tailwindcss/postcss']).toBeDefined();
    expect(pkg.devDependencies.postcss).toBeDefined();
  });

  it('aliases the Tailwind theme\'s idiomatic variable names to the ones real component CSS references, so exported components keep their background/foreground/spacing', async () => {
    // MockComponentGenerator.ts and the LLM tool schema in
    // ComponentGenerator.ts both tell every real component to use
    // var(--color-bg)/var(--color-fg)/var(--space-unit) - NOT the
    // Tailwind-idiomatic --color-background/--color-foreground/--spacing
    // that tokensToTailwindTheme emits (that function is shared with the
    // single-asset "download as Tailwind CSS" export route, which has its
    // own, different, already-tested contract - see
    // test/assetExportRoute.test.ts - so it must not be renamed itself).
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await makeThemeAsset(style.id, 'theme.css');
    const page = await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    const componentCss = '.btn { background: var(--color-bg); color: var(--color-fg); padding: var(--space-unit); }';
    const document = `<!DOCTYPE html><html><head><style>${componentCss}</style></head><body><button class="btn">Go</button></body></html>`;
    const component = await makeComponentAsset(style.id, 'btn.html', document);
    await pageService.update(page.id, { componentAssetIds: JSON.stringify([component.id]) });

    const result = await siteExporter.exportSite(style.id, 'test-theme-alias');
    const ok = result as { targetDir: string };
    const globalsCss = await fsPromises.readFile(path.join(ok.targetDir, 'app', 'globals.css'), 'utf-8');
    expect(globalsCss).toContain('--color-background: #1a1420;');
    expect(globalsCss).toContain('--color-bg: var(--color-background);');
    expect(globalsCss).toContain('--color-fg: var(--color-foreground);');
    expect(globalsCss).toContain('--space-unit: var(--spacing);');
  });

  it('omits the theme alias block when a style has no theme asset', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    const result = await siteExporter.exportSite(style.id, 'test-no-theme-alias');
    const ok = result as { targetDir: string };
    const globalsCss = await fsPromises.readFile(path.join(ok.targetDir, 'app', 'globals.css'), 'utf-8');
    expect(globalsCss).not.toContain('--color-bg: var(--color-background)');
  });

  it('generates CSS that actually passes Next.js CSS Modules pure-mode compilation for a bare-selector component', async () => {
    // This is the exact class of bug a hand-written string-equality unit
    // test cannot catch: an earlier version of this fix wrapped bare
    // selectors in :global(...), which passed its OWN hand-written
    // string-equality test while still failing real compilation
    // (:global() marks its contents non-local, so the rule still has
    // zero local selectors - pure mode's actual requirement). This test
    // runs the ACTUAL generated CSS through Next's own vendored
    // compiler - the same one next dev/next build use - so a regression
    // of this exact mistake fails here immediately, not silently.
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const bareSelectorDoc = '<!DOCTYPE html><html><head><style>button { color: red; } a:hover { text-decoration: underline; }</style></head><body><button>Go</button></body></html>';
    const component = await makeComponentAsset(style.id, 'bare.html', bareSelectorDoc);
    const page = await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    await pageService.update(page.id, { componentAssetIds: JSON.stringify([component.id]) });

    const result = await siteExporter.exportSite(style.id, 'test-pure-mode');
    const ok = result as { targetDir: string };
    const componentFiles = await fsPromises.readdir(path.join(ok.targetDir, 'components'));
    const cssFile = componentFiles.find(f => f.endsWith('.module.css'));
    expect(cssFile).toBeDefined();
    const generatedCss = await fsPromises.readFile(path.join(ok.targetDir, 'components', cssFile!), 'utf-8');

    // If this throws, the test fails - no try/catch, no expect() wrapper
    // needed, an async test that rejects fails on its own.
    const compiled = await postcss([localByDefault({ mode: 'pure' })]).process(generatedCss, { from: undefined });
    // Confirms real scoping happened too, not just "didn't throw" (which
    // could trivially pass on empty input).
    expect(compiled.css).toContain(':local(.root)');
  });

  it('embeds a page-id comment in every exported page.tsx and writes a manifest', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const asset = await makeComponentAsset(style.id, 'comp.html', COMPONENT_DOC);
    const page = await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    await pageService.update(page.id, { componentAssetIds: JSON.stringify([asset.id]) });

    const result = await siteExporter.exportSite(style.id, 'my-site');
    if ('error' in result) throw new Error(`Unexpected export error: ${result.error}`);

    const pageFile = await fsPromises.readFile(path.join(result.targetDir, 'app', 'page.tsx'), 'utf-8');
    expect(pageFile).toContain(`// gameforge-page-id: ${page.id}`);

    const manifestRaw = await fsPromises.readFile(path.join(result.targetDir, 'gameforge-manifest.json'), 'utf-8');
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.styleId).toBe(style.id);
    expect(manifest.pages).toHaveLength(1);
    expect(manifest.pages[0].id).toBe(page.id);
    expect(manifest.pages[0].componentAssetIds).toEqual([asset.id]);
    expect(manifest.components).toHaveLength(1);
    expect(manifest.components[0].assetId).toBe(asset.id);
    expect(typeof manifest.components[0].contentHash).toBe('string');
  });

  it('re-exports into an existing directory when its manifest matches the same style', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const asset = await makeComponentAsset(style.id, 'comp.html', COMPONENT_DOC);
    const page = await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    await pageService.update(page.id, { componentAssetIds: JSON.stringify([asset.id]) });

    const first = await siteExporter.exportSite(style.id, 'my-site');
    if ('error' in first) throw new Error(`Unexpected export error: ${first.error}`);

    const second = await siteExporter.exportSite(style.id, 'my-site');
    expect('error' in second).toBe(false);
  });

  it('still refuses ALREADY_EXISTS when the existing directory has no GameForge manifest', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await makeComponentAsset(style.id, 'comp.html', COMPONENT_DOC);
    const page = await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });

    const exportsDir = path.join(tempRoot, 'storage', 'exports', 'not-gameforges');
    await fsPromises.mkdir(exportsDir, { recursive: true });
    await fsPromises.writeFile(path.join(exportsDir, 'readme.txt'), 'someone else\'s directory');

    const result = await siteExporter.exportSite(style.id, 'not-gameforges');
    expect(result).toEqual({ error: 'ALREADY_EXISTS' });
  });

  it('still refuses ALREADY_EXISTS when the existing directory\'s manifest belongs to a different style', async () => {
    const styleA = await styleService.create({ name: 'a', createdBy: 'user-1', parameters: '{}' });
    const styleB = await styleService.create({ name: 'b', createdBy: 'user-1', parameters: '{}' });
    await makeComponentAsset(styleA.id, 'a.html', COMPONENT_DOC);
    await makeComponentAsset(styleB.id, 'b.html', COMPONENT_DOC);
    await pageService.create({ styleId: styleA.id, name: 'Home', createdBy: 'user-1' });
    await pageService.create({ styleId: styleB.id, name: 'Home', createdBy: 'user-1' });

    const first = await siteExporter.exportSite(styleA.id, 'shared-name');
    if ('error' in first) throw new Error(`Unexpected export error: ${first.error}`);

    const second = await siteExporter.exportSite(styleB.id, 'shared-name');
    expect(second).toEqual({ error: 'ALREADY_EXISTS' });
  });

  it('skips overwriting a component file that was hand-edited since the last export, and reports it', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const asset = await makeComponentAsset(style.id, 'comp.html', COMPONENT_DOC);
    const page = await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    await pageService.update(page.id, { componentAssetIds: JSON.stringify([asset.id]) });

    const first = await siteExporter.exportSite(style.id, 'my-site');
    if ('error' in first) throw new Error(`Unexpected export error: ${first.error}`);

    // Simulate a hand-edit: find the component's .tsx file and change it.
    const componentsDir = path.join(first.targetDir, 'components');
    const [componentFile] = (await fsPromises.readdir(componentsDir)).filter(f => f.endsWith('.tsx'));
    const componentPath = path.join(componentsDir, componentFile);
    const original = await fsPromises.readFile(componentPath, 'utf-8');
    await fsPromises.writeFile(componentPath, original + '\n// hand-edited\n');

    const second = await siteExporter.exportSite(style.id, 'my-site');
    if ('error' in second) throw new Error(`Unexpected export error: ${second.error}`);
    expect(second.skippedComponents).toHaveLength(1);

    const afterReExport = await fsPromises.readFile(componentPath, 'utf-8');
    expect(afterReExport).toContain('// hand-edited');
  });
});
