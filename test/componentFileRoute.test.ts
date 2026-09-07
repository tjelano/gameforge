import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { assetService } from '@/lib/services/AssetService';
import { GET } from '@/app/api/components/[filename]/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-componentroute-'));
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

async function seedPromotedTheme(css: string): Promise<string> {
  const style = await styleService.create({ name: `style-${randomUUID()}`, createdBy: 'user-1', parameters: '{}' });
  const filename = `${randomUUID()}.css`;
  await fsPromises.writeFile(path.join(tempRoot, 'storage', 'themes', filename), css);
  await assetService.create({
    styleId: style.id,
    createdBy: 'user-1',
    assetType: 'theme',
    prompt: 'test theme',
    imagePath: filename,
    outputKind: 'theme',
  });
  return style.id;
}

describe('GET /api/components/[filename]', () => {
  it('serves a stored component file as text/html with a restrictive CSP header', async () => {
    // A real <style>/<body> document, same shape combineComponentHtml
    // produces — the route now re-parses and re-sanitizes on serve, so a
    // document missing a <style> section would fail parsing entirely.
    const document = '<!DOCTYPE html><html><head><style>.btn { color: red; }</style></head><body><p>hi</p></body></html>';
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'components', 'test.html'), document);
    const res = await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ filename: 'test.html' }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    const body = await res.text();
    expect(body).toContain('hi');
    expect(body).toContain('.btn { color: red; }');
  });

  it('rejects a path-traversal filename', async () => {
    const res = await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ filename: '../../etc/passwd' }) });
    expect(res.status).toBe(400);
  });

  it('returns 404 for a nonexistent file', async () => {
    const res = await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ filename: 'nope.html' }) });
    expect(res.status).toBe(404);
  });

  it('strips a <script> tag from a file written directly to disk, bypassing every normal write path', async () => {
    // Simulates the actual threat: the file never went through
    // generate/edit/reset's sanitizing writes at all — e.g. it arrived via
    // `git pull` from another machine, an older less-hardened version of
    // this code, or a bad merge. The route must still not serve the
    // <script> back out.
    const hostileDocument = '<!DOCTYPE html><html><head><style>.btn { color: red; }</style></head>'
      + '<body><button onclick="alert(1)">Click</button><script>alert(document.cookie)</script></body></html>';
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'components', 'hostile.html'), hostileDocument);
    const res = await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ filename: 'hostile.html' }) });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('<script');
    expect(body).not.toContain('alert(document.cookie)');
    expect(body).not.toContain('onclick');
    expect(body).toContain('<button');
  });

  it('returns 500 for a file written directly to disk with CSS that cannot survive re-sanitization', async () => {
    // Same out-of-band-write threat as above, but with a payload that
    // sanitizeComponentCss rejects outright (url() is not in its function
    // allowlist) rather than one it can strip down to something safe. The
    // route must fail closed — never fall back to serving the raw bytes.
    const hostileDocument = '<!DOCTYPE html><html><head><style>.btn { background: url(https://evil.example/x); }</style></head>'
      + '<body><p>hi</p></body></html>';
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'components', 'hostile-css.html'), hostileDocument);
    const res = await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ filename: 'hostile-css.html' }) });
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain('evil.example');
  });

  it('injects the style\'s promoted theme CSS variables when ?styleId= names a style with a promoted theme', async () => {
    const styleId = await seedPromotedTheme(':root { --color-accent: #ff6600; }');
    const document = '<!DOCTYPE html><html><head><style>.btn { background: var(--color-accent); }</style></head><body><button>Go</button></body></html>';
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'components', 'themed.html'), document);
    const res = await GET(new NextRequest(`http://localhost/x?styleId=${styleId}`), { params: Promise.resolve({ filename: 'themed.html' }) });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('--color-accent: #ff6600');
    expect(body).toContain('var(--color-accent)');
  });

  it('serves the component unchanged when ?styleId= names a style with no promoted theme', async () => {
    const style = await styleService.create({ name: `style-${randomUUID()}`, createdBy: 'user-1', parameters: '{}' });
    const document = '<!DOCTYPE html><html><head><style>.btn { color: red; }</style></head><body><p>hi</p></body></html>';
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'components', 'notheme.html'), document);
    const res = await GET(new NextRequest(`http://localhost/x?styleId=${style.id}`), { params: Promise.resolve({ filename: 'notheme.html' }) });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain(':root');
  });

  it('serves the component unchanged when no ?styleId= is given', async () => {
    const document = '<!DOCTYPE html><html><head><style>.btn { color: red; }</style></head><body><p>hi</p></body></html>';
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'components', 'plain.html'), document);
    const res = await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ filename: 'plain.html' }) });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain(':root');
  });

  it('never splices raw theme CSS in — it re-sanitizes the theme file the same as a component file', async () => {
    // The theme pipeline (ThemeTokensSchema) validates at generation/edit
    // time, not at serve time, so a hostile or corrupted theme CSS file must
    // be caught here, the same way a hostile component file is caught above.
    // Falls back to "no injection" rather than failing the whole request —
    // the component itself is still safe and valid; only its theming is lost.
    const styleId = await seedPromotedTheme(':root { --color-accent: url(https://evil.example/x); }');
    const document = '<!DOCTYPE html><html><head><style>.btn { color: red; }</style></head><body><p>hi</p></body></html>';
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'components', 'hostile-theme.html'), document);
    const res = await GET(new NextRequest(`http://localhost/x?styleId=${styleId}`), { params: Promise.resolve({ filename: 'hostile-theme.html' }) });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('evil.example');
    expect(body).not.toContain(':root');
  });
});
