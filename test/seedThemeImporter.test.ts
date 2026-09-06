import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { assetService } from '@/lib/services/AssetService';
import { importSeedThemes } from '@/lib/services/SeedThemeImporter';

let tempRoot: string;

const DAISYUI_CSS = '[data-theme=light]{color-scheme:light;--a:76.76% 0.184 183.61;--n:32.1785% 0.02476 255.701624;--b1:100% 0 0;--bc:27.8078% 0.029596 256.847952;--rounded-btn:0.5rem}';
const DAISYUI_CSS_TWO_THEMES = DAISYUI_CSS + '[data-theme=dark]{color-scheme:dark;--a:76.76% 0.184 183.61;--n:32.1785% 0.02476 255.701624;--b1:100% 0 0;--bc:27.8078% 0.029596 256.847952;--rounded-btn:0.5rem}';
const BOOTSWATCH_API_JSON = JSON.stringify({
  themes: [{ name: 'Flatly', cssMin: 'https://bootswatch.com/5/flatly/bootstrap.min.css' }],
});
const FLATLY_CSS = ':root{--bs-body-bg:#fff;--bs-body-color:#212529;--bs-primary:#2c3e50;--bs-border-color:#dee2e6;--bs-border-radius:0.375rem}';

function stubFetchWithBothSources() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === 'https://unpkg.com/daisyui@4.9.0/dist/themes.css') return new Response(DAISYUI_CSS, { status: 200 });
    if (url === 'https://bootswatch.com/api/5.json') return new Response(BOOTSWATCH_API_JSON, { status: 200 });
    if (url === 'https://bootswatch.com/5/flatly/bootstrap.min.css') return new Response(FLATLY_CSS, { status: 200 });
    throw new Error(`Unexpected fetch to ${url}`);
  }));
}

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-seedtheme-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'themes'), { recursive: true });

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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('importSeedThemes', () => {
  it('creates a Style Bible + theme asset for each theme from both sources', async () => {
    stubFetchWithBothSources();

    const result = await importSeedThemes();

    expect(result).toEqual({ imported: 2, skipped: 0, errors: [] });

    const styles = await styleService.getAll();
    const names = styles.map(s => s.name).sort();
    expect(names).toEqual(['Bootswatch: Flatly', 'DaisyUI: light']);
    for (const style of styles) {
      expect(style.created_by).toBe('system-seed');
    }

    const assets = await assetService.getAll();
    expect(assets).toHaveLength(2);
    for (const asset of assets) {
      expect(asset.output_kind).toBe('theme');
      expect(asset.created_by).toBe('system-seed');
      expect(asset.is_deleted).toBe(0);
    }
  });

  it('is idempotent — a second run imports nothing new', async () => {
    stubFetchWithBothSources();
    await importSeedThemes();

    stubFetchWithBothSources();
    const secondResult = await importSeedThemes();

    expect(secondResult).toEqual({ imported: 0, skipped: 2, errors: [] });
    const styles = await styleService.getAll();
    expect(styles).toHaveLength(2);
  });

  it('isolates a DaisyUI fetch failure — Bootswatch still imports', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'https://unpkg.com/daisyui@4.9.0/dist/themes.css') return new Response('', { status: 503, statusText: 'Service Unavailable' });
      if (url === 'https://bootswatch.com/api/5.json') return new Response(BOOTSWATCH_API_JSON, { status: 200 });
      if (url === 'https://bootswatch.com/5/flatly/bootstrap.min.css') return new Response(FLATLY_CSS, { status: 200 });
      throw new Error(`Unexpected fetch to ${url}`);
    }));

    const result = await importSeedThemes();

    expect(result.imported).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/DaisyUI/);
    const styles = await styleService.getAll();
    expect(styles.map(s => s.name)).toEqual(['Bootswatch: Flatly']);
  });

  it('isolates a per-theme creation failure — the rest of that source and the other source still import', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'https://unpkg.com/daisyui@4.9.0/dist/themes.css') return new Response(DAISYUI_CSS_TWO_THEMES, { status: 200 });
      if (url === 'https://bootswatch.com/api/5.json') return new Response(BOOTSWATCH_API_JSON, { status: 200 });
      if (url === 'https://bootswatch.com/5/flatly/bootstrap.min.css') return new Response(FLATLY_CSS, { status: 200 });
      throw new Error(`Unexpected fetch to ${url}`);
    }));

    const originalCreate = styleService.create.bind(styleService);
    vi.spyOn(styleService, 'create').mockImplementation(async (input) => {
      if (input.name === 'DaisyUI: dark') throw new Error('disk full');
      return originalCreate(input);
    });

    const result = await importSeedThemes();

    expect(result.imported).toBe(2); // DaisyUI: light + Bootswatch: Flatly
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/DaisyUI: dark/);

    const styles = await styleService.getAll();
    expect(styles.map(s => s.name).sort()).toEqual(['Bootswatch: Flatly', 'DaisyUI: light']);
  });
});
