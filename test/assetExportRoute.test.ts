// test/assetExportRoute.test.ts
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
import { GET } from '@/app/api/assets/[id]/export/route';

let tempRoot: string;

const TOKENS: ThemeTokens = {
  colorBackground: '#1a1420',
  colorForeground: '#f0e6d2',
  colorAccent: '#e8a33d',
  colorBorder: '#4a3728',
  fontHeading: "'Cinzel', serif",
  fontBody: "'EB Garamond', serif",
  spaceUnit: '8px',
  radiusBase: '4px',
};

async function makeThemeAsset(styleName: string): Promise<{ assetId: string }> {
  const style = await styleService.create({ name: styleName, createdBy: 'user-1', parameters: '{}' });
  const filename = `theme-${style.id}.css`;
  await fsPromises.writeFile(path.join(tempRoot, 'storage', 'themes', filename), tokensToCss(TOKENS));
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
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-themeexport-'));
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

describe('GET /api/assets/[id]/export', () => {
  it('exports a theme asset as Tailwind CSS with the correct headers and filename', async () => {
    const { assetId } = await makeThemeAsset('DaisyUI: Cyberpunk');
    const req = new NextRequest(`http://localhost/api/assets/${assetId}/export?format=tailwind`);
    const res = await GET(req, { params: Promise.resolve({ id: assetId }) });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/css');
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="daisyui-cyberpunk.css"');
    const body = await res.text();
    expect(body).toContain('@theme {');
    expect(body).toContain('--color-background: #1a1420;');
  });

  it('exports a theme asset as W3C tokens JSON with the correct headers and filename', async () => {
    const { assetId } = await makeThemeAsset('Bootswatch: Flatly');
    const req = new NextRequest(`http://localhost/api/assets/${assetId}/export?format=w3c`);
    const res = await GET(req, { params: Promise.resolve({ id: assetId }) });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="bootswatch-flatly.json"');
    const doc = JSON.parse(await res.text());
    expect(doc.color.background.$type).toBe('color');
  });

  it('returns 404 for a nonexistent asset', async () => {
    const req = new NextRequest('http://localhost/api/assets/00000000-0000-0000-0000-000000000000/export?format=tailwind');
    const res = await GET(req, { params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' }) });
    expect(res.status).toBe(404);
  });

  it('returns 400 for a non-theme asset', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const asset = await assetService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'sprite', prompt: 'x', imagePath: 'x.png', outputKind: 'image',
    });
    const req = new NextRequest(`http://localhost/api/assets/${asset.id}/export?format=tailwind`);
    const res = await GET(req, { params: Promise.resolve({ id: asset.id }) });
    expect(res.status).toBe(400);
  });

  it('returns 400 for an invalid format param', async () => {
    const { assetId } = await makeThemeAsset('x');
    const req = new NextRequest(`http://localhost/api/assets/${assetId}/export?format=nonsense`);
    const res = await GET(req, { params: Promise.resolve({ id: assetId }) });
    expect(res.status).toBe(400);
  });

  it('returns 500 when the theme CSS file is missing on disk', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const asset = await assetService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x', imagePath: 'missing.css', outputKind: 'theme',
    });
    const req = new NextRequest(`http://localhost/api/assets/${asset.id}/export?format=tailwind`);
    const res = await GET(req, { params: Promise.resolve({ id: asset.id }) });
    expect(res.status).toBe(500);
  });
});
