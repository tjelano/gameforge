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
});
