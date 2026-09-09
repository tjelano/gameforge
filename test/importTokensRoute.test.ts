// test/importTokensRoute.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { seedSession } from './helpers/testSession';
import { styleService } from '@/lib/services/StyleService';
import { assetService } from '@/lib/services/AssetService';
import { tokensToW3cTokens } from '@/lib/services/themeExport/w3cExporter';
import { POST } from '@/app/api/styles/import-tokens/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-importtokens-'));
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

function req(body: unknown, cookieHeader?: string): NextRequest {
  return new NextRequest('http://localhost/api/styles/import-tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
    body: JSON.stringify(body),
  });
}

const VALID_TOKENS = tokensToW3cTokens({
  colorBackground: '#ffffff',
  colorForeground: '#212529',
  colorAccent: '#2c3e50',
  colorBorder: '#dee2e6',
  fontHeading: "'Playfair Display', serif",
  fontBody: 'Arial',
  spaceUnit: '0.5rem',
  radiusBase: '0.375rem',
});

describe('POST /api/styles/import-tokens', () => {
  it('requires login', async () => {
    const res = await POST(req({ name: 'Imported', tokensJson: VALID_TOKENS }));
    expect(res.status).toBe(401);
  });

  it('creates a Style Bible and a promoted theme asset from a valid tokens file', async () => {
    const { cookieHeader, userId } = await seedSession();
    const res = await POST(req({ name: 'My Imported Style', tokensJson: VALID_TOKENS }, cookieHeader));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.name).toBe('My Imported Style');
    expect(body.data.created_by).toBe(userId);

    const assets = await assetService.getActiveAssetsForStyle(body.data.id);
    expect(assets).toHaveLength(1);
    expect(assets[0].output_kind).toBe('theme');
    expect(assets[0].image_path).toMatch(/\.css$/);

    const cssContent = await fsPromises.readFile(path.join(tempRoot, 'storage', 'themes', assets[0].image_path!), 'utf-8');
    expect(cssContent).toContain('--color-accent');
  });

  it('rejects an empty name with a 400', async () => {
    const { cookieHeader } = await seedSession();
    const res = await POST(req({ name: '', tokensJson: VALID_TOKENS }, cookieHeader));
    expect(res.status).toBe(400);
  });

  it('returns the parser\'s error message and creates nothing when required roles are missing', async () => {
    const { cookieHeader } = await seedSession();
    const incomplete = JSON.stringify({ color: { accent: { $type: 'color', $value: { colorSpace: 'srgb', components: [1, 0, 0], alpha: 1 } } } });
    const res = await POST(req({ name: 'Incomplete', tokensJson: incomplete }, cookieHeader));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toContain('colorBackground');

    const styles = await styleService.getAll();
    expect(styles.filter(s => s.name === 'Incomplete')).toHaveLength(0);
  });

  it('returns a 400 for malformed JSON in tokensJson, not a 500', async () => {
    const { cookieHeader } = await seedSession();
    const res = await POST(req({ name: 'Broken', tokensJson: 'not valid json {' }, cookieHeader));
    expect(res.status).toBe(400);
  });

  it('returns a 400 (not a 500) for a pathologically deeply-nested tokensJson, and creates nothing', async () => {
    const { cookieHeader } = await seedSession();
    // Built as a raw string via repetition, not JSON.stringify(deeplyNestedObject)
    // - see the matching test in w3cImporter.test.ts for why.
    const deepJson = '{"nested":'.repeat(5000)
      + '{"$type":"color","$value":{"colorSpace":"srgb","components":[1,0,0],"alpha":1}}'
      + '}'.repeat(5000);
    const res = await POST(req({ name: 'TooDeep', tokensJson: deepJson }, cookieHeader));
    expect(res.status).toBe(400);

    const styles = await styleService.getAll();
    expect(styles.filter(s => s.name === 'TooDeep')).toHaveLength(0);
  });

  it('rejects a tokensJson payload over the size ceiling with a 400', async () => {
    const { cookieHeader } = await seedSession();
    const huge = 'a'.repeat(2_000_001);
    const res = await POST(req({ name: 'Huge', tokensJson: huge }, cookieHeader));
    expect(res.status).toBe(400);
  });
});
