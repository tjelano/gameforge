// test/assetExportRoute.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
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

async function makeThemeAsset(styleName: string, tokens: ThemeTokens = TOKENS): Promise<{ assetId: string }> {
  const style = await styleService.create({ name: styleName, createdBy: 'user-1', parameters: '{}' });
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

const IMG_DOC = '<!DOCTYPE html><html><head><style>.hero { color: red; }</style></head>'
  + '<body><div class="hero"><img src="/hero.png" alt="Hero"></div></body></html>';

async function makeComponentAsset(
  styleName: string,
  document: string,
  assetType = 'button'
): Promise<{ assetId: string }> {
  const style = await styleService.create({ name: styleName, createdBy: 'user-1', parameters: '{}' });
  const filename = `component-${style.id}.html`;
  await fsPromises.writeFile(path.join(tempRoot, 'storage', 'components', filename), document);
  const asset = await assetService.create({
    styleId: style.id,
    createdBy: 'user-1',
    assetType,
    prompt: 'x',
    imagePath: filename,
    outputKind: 'component',
  });
  return { assetId: asset.id };
}

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-themeexport-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'themes'), { recursive: true });
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'components'), { recursive: true });

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

  it('returns 422 (not 500) when a theme value is valid CSS but unrepresentable in the requested export format', async () => {
    // spaceUnit '1em' passes ThemeTokensSchema (CSS_LENGTH_RE still allows em
    // for backward compatibility) but the W3C exporter's dimensionToken()
    // only accepts px/rem, per the real Design Tokens spec.
    const { assetId } = await makeThemeAsset('x', { ...TOKENS, spaceUnit: '1em' });
    const req = new NextRequest(`http://localhost/api/assets/${assetId}/export?format=w3c`);
    const res = await GET(req, { params: Promise.resolve({ id: assetId }) });
    expect(res.status).toBe(422);
  });

  it('returns 400 when asset.image_path contains a path-traversal sequence', async () => {
    // Inserted directly, bypassing assetService.create's normal flow — this
    // shape can only arise from a corrupted/hostile git-synced import, not
    // from anything the app itself would write.
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const db = DatabaseConnection.getInstance();
    const assetId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted, source_job_id, output_kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(assetId, style.id, 'user-1', 'theme', 'x', '../../../secrets.css', Date.now(), null, 'theme');

    const req = new NextRequest(`http://localhost/api/assets/${assetId}/export?format=tailwind`);
    const res = await GET(req, { params: Promise.resolve({ id: assetId }) });
    expect(res.status).toBe(400);
  });

  it('falls back to "theme" for the filename when the style name slugifies to an empty string', async () => {
    const { assetId } = await makeThemeAsset('🎨');
    const req = new NextRequest(`http://localhost/api/assets/${assetId}/export?format=tailwind`);
    const res = await GET(req, { params: Promise.resolve({ id: assetId }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="theme.css"');
  });

  it('exports a component asset as a standalone sanitized HTML document', async () => {
    const document = '<!DOCTYPE html><html><head><style>.btn { color: red; }</style></head><body><button class="btn">Go</button></body></html>';
    const { assetId } = await makeComponentAsset('DaisyUI: Cyberpunk', document, 'primary button');
    const req = new NextRequest(`http://localhost/api/assets/${assetId}/export?format=html`);
    const res = await GET(req, { params: Promise.resolve({ id: assetId }) });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html');
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="daisyui-cyberpunk-primary-button.html"');
    const body = await res.text();
    expect(body).toContain('<button class="btn">Go</button>');
    expect(body).toContain('.btn { color: red; }');
  });

  it('strips disallowed content from a component export, same as the serve route', async () => {
    const document = '<!DOCTYPE html><html><head><style>.btn { color: red; }</style></head><body><button class="btn" onclick="alert(1)">Go</button><script>alert(2)</script></body></html>';
    const { assetId } = await makeComponentAsset('x', document);
    const req = new NextRequest(`http://localhost/api/assets/${assetId}/export?format=html`);
    const res = await GET(req, { params: Promise.resolve({ id: assetId }) });

    const body = await res.text();
    expect(body).not.toContain('onclick');
    expect(body).not.toContain('<script>');
  });

  it('rejects a non-"html" format for a component asset', async () => {
    const { assetId } = await makeComponentAsset('x', '<!DOCTYPE html><html><head><style>a{}</style></head><body>x</body></html>');
    const req = new NextRequest(`http://localhost/api/assets/${assetId}/export?format=tailwind`);
    const res = await GET(req, { params: Promise.resolve({ id: assetId }) });
    expect(res.status).toBe(400);
  });

  it('downloads a component marked edited_externally with its hand-edited content intact', async () => {
    // <img> is deliberately excluded from componentSanitize's ALLOWED_TAGS,
    // so it is the reliable "sanitizer would strip this" payload — and the
    // exact case reverse-sync's trustAsEdited path exists for.
    const { assetId } = await makeComponentAsset('Trusted Style', IMG_DOC);
    await assetService.update(assetId, { editedExternally: true });
    const req = new NextRequest(`http://localhost/api/assets/${assetId}/export?format=html`);
    const res = await GET(req, { params: Promise.resolve({ id: assetId }) });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="trusted-style-button.html"');
    const body = await res.text();
    expect(body).toContain('<img');
    expect(body).toContain('/hero.png');
  });

  it('still sanitizes a component download when the asset is not marked edited_externally', async () => {
    const { assetId } = await makeComponentAsset('Untrusted Style', IMG_DOC);
    const req = new NextRequest(`http://localhost/api/assets/${assetId}/export?format=html`);
    const res = await GET(req, { params: Promise.resolve({ id: assetId }) });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('<img');
    expect(body).not.toContain('/hero.png');
  });

  it('returns 500 when the component file is missing on disk', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const asset = await assetService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'button', prompt: 'x', imagePath: 'missing.html', outputKind: 'component',
    });
    const req = new NextRequest(`http://localhost/api/assets/${asset.id}/export?format=html`);
    const res = await GET(req, { params: Promise.resolve({ id: asset.id }) });
    expect(res.status).toBe(500);
  });
});
