// test/pageRenderRoute.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { assetService } from '@/lib/services/AssetService';
import { pageService } from '@/lib/services/PageService';
import { GET } from '@/app/api/pages/[id]/render/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-pagerender-'));
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

const IMG_DOC = '<!DOCTYPE html><html><head><style>.hero { color: red; }</style></head>'
  + '<body><div class="hero"><img src="/hero.png" alt="Hero"></div></body></html>';

async function makeComponentAsset(styleId: string, filename: string, document: string, assetType = 'button') {
  await fsPromises.writeFile(path.join(tempRoot, 'storage', 'components', filename), document);
  return assetService.create({
    styleId, createdBy: 'user-1', assetType, prompt: 'x', imagePath: filename, outputKind: 'component',
  });
}

describe('GET /api/pages/[id]/render', () => {
  it('returns 404 for a nonexistent page', async () => {
    const res = await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' }) });
    expect(res.status).toBe(404);
  });

  it('composes an empty page (no components) into a valid document', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const page = await pageService.create({ styleId: style.id, name: 'Empty', createdBy: 'user-1' });
    const res = await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ id: page.id }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    const body = await res.text();
    expect(body).toContain('<!DOCTYPE html>');
  });

  it('composes multiple components in order with scoped, non-colliding CSS, plus the theme', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'themes', 'theme.css'), ':root { --color-accent: #ff6600; }');
    await assetService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x', imagePath: 'theme.css', outputKind: 'theme',
    });
    const navAsset = await makeComponentAsset(style.id, 'nav.html',
      '<!DOCTYPE html><html><head><style>.title { color: red; }</style></head><body><nav class="title">Nav</nav></body></html>', 'nav bar');
    const heroAsset = await makeComponentAsset(style.id, 'hero.html',
      '<!DOCTYPE html><html><head><style>.title { color: blue; }</style></head><body><h1 class="title">Hero</h1></body></html>', 'hero');

    const page = await pageService.create({ styleId: style.id, name: 'Landing', createdBy: 'user-1' });
    await pageService.update(page.id, { componentAssetIds: JSON.stringify([navAsset.id, heroAsset.id]) });

    const res = await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ id: page.id }) });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('--color-accent: #ff6600');
    expect(body.indexOf('Nav')).toBeLessThan(body.indexOf('Hero'));
    const scopedTitleMatches = [...body.matchAll(/(\.page-item-\d+)\s+\.title/g)].map(m => m[1]);
    expect(new Set(scopedTitleMatches).size).toBe(2);
  });

  it('skips a stale component reference and still renders the remaining valid ones', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
      const validAsset = await makeComponentAsset(style.id, 'valid.html',
        '<!DOCTYPE html><html><head><style>.a {}</style></head><body><p>Still Here</p></body></html>');
      const page = await pageService.create({ styleId: style.id, name: 'x', createdBy: 'user-1' });
      await pageService.update(page.id, {
        componentAssetIds: JSON.stringify(['00000000-0000-0000-0000-000000000000', validAsset.id]),
      });

      const res = await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ id: page.id }) });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('Still Here');
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('sanitizes a hostile component instead of serving it raw', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const hostileAsset = await makeComponentAsset(style.id, 'hostile.html',
      '<!DOCTYPE html><html><head><style>.a {}</style></head><body><button onclick="alert(1)">Go</button><script>alert(document.cookie)</script></body></html>');
    const page = await pageService.create({ styleId: style.id, name: 'x', createdBy: 'user-1' });
    await pageService.update(page.id, { componentAssetIds: JSON.stringify([hostileAsset.id]) });

    const res = await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ id: page.id }) });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('<script');
    expect(body).not.toContain('onclick');
    expect(body).not.toContain('alert(document.cookie)');
  });

  it('skips a component whose CSS fails sanitization, still renders the rest of the page', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const hostileAsset = await makeComponentAsset(style.id, 'hostile-css.html',
      '<!DOCTYPE html><html><head><style>.a { background: url(https://evil.example/x); }</style></head><body><p>Hostile</p></body></html>');
    const validAsset = await makeComponentAsset(style.id, 'valid.html',
      '<!DOCTYPE html><html><head><style>.a {}</style></head><body><p>Still Here</p></body></html>');
    const page = await pageService.create({ styleId: style.id, name: 'x', createdBy: 'user-1' });
    await pageService.update(page.id, { componentAssetIds: JSON.stringify([hostileAsset.id, validAsset.id]) });

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ id: page.id }) });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('Still Here');
      expect(body).not.toContain('Hostile');
      expect(body).not.toContain('evil.example');
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('renders hand-edited content intact when the component asset is marked edited_externally', async () => {
    // <img> is deliberately excluded from componentSanitize's ALLOWED_TAGS,
    // so it is the reliable "sanitizer strips this" payload — and the exact
    // case reverse-sync's trustAsEdited path exists for. Without the trust
    // check this route stripped it back out on every page preview/download.
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const asset = await makeComponentAsset(style.id, 'trusted.html', IMG_DOC);
    await assetService.update(asset.id, { editedExternally: true });
    const page = await pageService.create({ styleId: style.id, name: 'x', createdBy: 'user-1' });
    await pageService.update(page.id, { componentAssetIds: JSON.stringify([asset.id]) });

    const res = await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ id: page.id }) });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<img');
    expect(body).toContain('/hero.png');
  });

  it('still sanitizes the same content when the component asset is not marked edited_externally', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const asset = await makeComponentAsset(style.id, 'untrusted.html', IMG_DOC);
    const page = await pageService.create({ styleId: style.id, name: 'x', createdBy: 'user-1' });
    await pageService.update(page.id, { componentAssetIds: JSON.stringify([asset.id]) });

    const res = await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ id: page.id }) });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('<img');
    expect(body).not.toContain('/hero.png');
  });

  it('with ?download=1, sets Content-Disposition to attachment with a slugified filename', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const page = await pageService.create({ styleId: style.id, name: 'My Landing Page!', createdBy: 'user-1' });
    const res = await GET(new NextRequest('http://localhost/x?download=1'), { params: Promise.resolve({ id: page.id }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="my-landing-page.html"');
  });

  it('without ?download=1, does not set Content-Disposition', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const page = await pageService.create({ styleId: style.id, name: 'x', createdBy: 'user-1' });
    const res = await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ id: page.id }) });
    expect(res.headers.get('Content-Disposition')).toBeNull();
  });

  it('with ?download=0 or any value other than "1", does not set Content-Disposition', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const page = await pageService.create({ styleId: style.id, name: 'x', createdBy: 'user-1' });
    const resZero = await GET(new NextRequest('http://localhost/x?download=0'), { params: Promise.resolve({ id: page.id }) });
    expect(resZero.headers.get('Content-Disposition')).toBeNull();
    const resOther = await GET(new NextRequest('http://localhost/x?download=foo'), { params: Promise.resolve({ id: page.id }) });
    expect(resOther.headers.get('Content-Disposition')).toBeNull();
  });
});
