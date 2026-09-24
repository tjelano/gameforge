// test/assetServiceWithContrastData.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { assetService } from '@/lib/services/AssetService';
import { tokensToCss, type ThemeTokens } from '@/lib/services/ThemeGenerator';

let tempRoot: string;

const HIGH_CONTRAST_TOKENS: ThemeTokens = {
  colorBackground: '#000000',
  colorForeground: '#ffffff',
  colorAccent: '#e8a33d',
  colorBorder: '#4a3728',
  fontHeading: "'Cinzel', serif",
  fontBody: "'EB Garamond', serif",
  spaceUnit: '8px',
  radiusBase: '4px',
};

async function makeThemeAsset(styleId: string, tokens: ThemeTokens): Promise<string> {
  const filename = `theme-${styleId}-${Math.random().toString(36).slice(2)}.css`;
  await fsPromises.writeFile(path.join(tempRoot, 'storage', 'themes', filename), tokensToCss(tokens));
  const asset = await assetService.create({
    styleId, createdBy: 'user-1', assetType: 'theme', prompt: 'x', imagePath: filename, outputKind: 'theme',
  });
  return asset.id;
}

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-withcontrast-'));
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
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('assetService.withContrastData', () => {
  it('attaches contrast: null for a non-theme asset without touching the filesystem', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const sprite = await assetService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'sprite', prompt: 'x', imagePath: 'sprite.png', outputKind: 'image',
    });
    const [result] = await assetService.withContrastData([sprite]);
    expect(result.contrast).toBeNull();
  });

  it('computes a real contrast ratio for a theme asset from its actual CSS file', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const assetId = await makeThemeAsset(style.id, HIGH_CONTRAST_TOKENS);
    const asset = (await assetService.getById(assetId))!;
    const [result] = await assetService.withContrastData([asset]);
    expect(result.contrast).not.toBeNull();
    expect(result.contrast!.ratio).toBeCloseTo(21, 0); // pure black/white = max ratio
    expect(result.contrast!.meetsAA).toBe(true);
  });

  it('returns contrast: null (not a thrown error) for a theme asset whose file is missing', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const asset = await assetService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x', imagePath: 'missing.css', outputKind: 'theme',
    });
    const [result] = await assetService.withContrastData([asset]);
    expect(result.contrast).toBeNull();
  });

  it('processes a full batch in one call, one bad asset does not affect the others', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const goodId = await makeThemeAsset(style.id, HIGH_CONTRAST_TOKENS);
    const badAsset = await assetService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x', imagePath: 'missing.css', outputKind: 'theme',
    });
    const spriteAsset = await assetService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'sprite', prompt: 'x', imagePath: 'sprite.png', outputKind: 'image',
    });
    const goodAsset = (await assetService.getById(goodId))!;

    const results = await assetService.withContrastData([goodAsset, badAsset, spriteAsset]);

    expect(results).toHaveLength(3);
    expect(results[0].contrast).not.toBeNull();
    expect(results[1].contrast).toBeNull();
    expect(results[2].contrast).toBeNull();
  });
});
