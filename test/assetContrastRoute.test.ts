// test/assetContrastRoute.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { assetService } from '@/lib/services/AssetService';
import { tokensToCss, type ThemeTokens } from '@/lib/services/ThemeGenerator';
import { GET } from '@/app/api/assets/[id]/contrast/route';

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

const LOW_CONTRAST_TOKENS: ThemeTokens = {
  ...HIGH_CONTRAST_TOKENS,
  colorBackground: '#888888',
  colorForeground: '#999999',
};

async function makeThemeAsset(tokens: ThemeTokens): Promise<{ assetId: string }> {
  const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
  const filename = `theme-${style.id}.css`;
  await fsPromises.writeFile(path.join(tempRoot, 'storage', 'themes', filename), tokensToCss(tokens));
  const asset = await assetService.create({
    styleId: style.id,
    createdBy: 'user-1',
    assetType: 'theme',
    prompt: 'x',
    imagePath: filename,
    outputKind: 'theme',
  });
  return { assetId: asset.id };
}

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-contrast-'));
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

describe('GET /api/assets/[id]/contrast', () => {
  it('returns a passing ratio for a high-contrast theme', async () => {
    const { assetId } = await makeThemeAsset(HIGH_CONTRAST_TOKENS);
    const req = new NextRequest(`http://localhost/api/assets/${assetId}/contrast`);
    const res = await GET(req, { params: Promise.resolve({ id: assetId }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.ratio).toBeCloseTo(21, 5);
    expect(body.data.meetsAA).toBe(true);
  });

  it('returns a failing result for a low-contrast theme', async () => {
    const { assetId } = await makeThemeAsset(LOW_CONTRAST_TOKENS);
    const req = new NextRequest(`http://localhost/api/assets/${assetId}/contrast`);
    const res = await GET(req, { params: Promise.resolve({ id: assetId }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.meetsAA).toBe(false);
  });

  it('returns 404 for a nonexistent asset', async () => {
    const req = new NextRequest('http://localhost/api/assets/00000000-0000-0000-0000-000000000000/contrast');
    const res = await GET(req, { params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' }) });
    expect(res.status).toBe(404);
  });

  it('returns 400 for a non-theme asset', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const asset = await assetService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'sprite', prompt: 'x', imagePath: 'x.png', outputKind: 'image',
    });
    const req = new NextRequest(`http://localhost/api/assets/${asset.id}/contrast`);
    const res = await GET(req, { params: Promise.resolve({ id: asset.id }) });
    expect(res.status).toBe(400);
  });

  it('returns 400 for a path-traversal image_path', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const db = DatabaseConnection.getInstance();
    const assetId = '11111111-1111-1111-1111-111111111111';
    db.prepare(
      `INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted, output_kind)
       VALUES (?, ?, 'user-1', 'theme', 'x', '../../../secrets.css', ?, 0, 'theme')`
    ).run(assetId, style.id, Date.now());
    const req = new NextRequest(`http://localhost/api/assets/${assetId}/contrast`);
    const res = await GET(req, { params: Promise.resolve({ id: assetId }) });
    expect(res.status).toBe(400);
  });

  it('returns 500 when the theme CSS file is missing on disk', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const asset = await assetService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x', imagePath: 'missing.css', outputKind: 'theme',
    });
    const req = new NextRequest(`http://localhost/api/assets/${asset.id}/contrast`);
    const res = await GET(req, { params: Promise.resolve({ id: asset.id }) });
    expect(res.status).toBe(500);
  });
});
