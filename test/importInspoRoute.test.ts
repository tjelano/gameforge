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
import { POST } from '@/app/api/styles/import-inspo/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-importinspo-'));
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
  return new NextRequest('http://localhost/api/styles/import-inspo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
    body: JSON.stringify(body),
  });
}

const VALID_TOKENS = {
  colorBackground: '#ffffff',
  colorForeground: '#111111',
  colorAccent: '#3b82f6',
  colorBorder: '#e5e7eb',
  fontHeading: 'Inter',
  fontBody: 'Georgia',
  spaceUnit: '8px',
  radiusBase: '6px',
};

describe('POST /api/styles/import-inspo', () => {
  it('requires login', async () => {
    const res = await POST(req({ name: 'X', slug: 'acme-corp', tokens: VALID_TOKENS, provenance: {}, lowConfidence: false }));
    expect(res.status).toBe(401);
  });

  it('rejects an invalid slug with a 400', async () => {
    const { cookieHeader } = await seedSession();
    const res = await POST(req({ name: 'X', slug: '../etc/passwd', tokens: VALID_TOKENS, provenance: {}, lowConfidence: false }, cookieHeader));
    expect(res.status).toBe(400);
  });

  it('rejects tampered tokens that fail ThemeTokensSchema, even though preview already validated once', async () => {
    const { cookieHeader } = await seedSession();
    const tampered = { ...VALID_TOKENS, colorAccent: "'; } body { background: url(evil) } .x {" };
    const res = await POST(req({ name: 'X', slug: 'acme-corp', tokens: tampered, provenance: {}, lowConfidence: false }, cookieHeader));
    expect(res.status).toBe(400);

    const styles = await styleService.getAll();
    expect(styles).toHaveLength(0);
  });

  it('creates a Style Bible with __source provenance from the approved tokens, no re-fetch', async () => {
    const { cookieHeader, userId } = await seedSession();
    const res = await POST(req({
      name: 'Acme Style', slug: 'acme-corp', tokens: VALID_TOKENS,
      provenance: { colorAccent: 'heuristic' }, lowConfidence: false,
    }, cookieHeader));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.created_by).toBe(userId);

    const parsed = JSON.parse(body.data.parameters);
    expect(parsed.colorAccent).toBe('#3b82f6');
    expect(parsed.__source.slug).toBe('acme-corp');
    expect(parsed.__source.provenance.colorAccent).toBe('heuristic');
    expect(typeof parsed.__source.importedAt).toBe('number');

    const assets = await assetService.getActiveAssetsForStyle(body.data.id);
    expect(assets).toHaveLength(1);
    expect(assets[0].output_kind).toBe('theme');
    expect(assets[0].prompt).toBe('Imported from Inspo: acme-corp');
  });
});
