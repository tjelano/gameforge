// test/suggestPageLayoutRoute.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { seedSession } from './helpers/testSession';
import { styleService } from '@/lib/services/StyleService';
import { assetService } from '@/lib/services/AssetService';
import { POST } from '@/app/api/styles/[id]/pages/suggest-layout/route';

let tempRoot: string;

beforeEach(async () => {
  // Forced deterministic regardless of the host machine's real env (e.g. a
  // CHEAPERINFERENCE_API_KEY set machine-wide for the deepseek-review skill)
  // - see getThemeGeneratorSelection.test.ts's identical note. This makes
  // getPageLayoutSuggester() resolve to MockPageLayoutSuggester, which
  // returns every candidate unfiltered, in the order given - exactly what
  // these route-level tests need; the suggestion logic itself is already
  // covered by pageLayoutSuggester.test.ts.
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('THEME_API_PROVIDER', '');

  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-suggestlayout-'));
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
  vi.unstubAllEnvs();
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

function req(body: unknown, cookieHeader?: string): NextRequest {
  return new NextRequest('http://localhost/api/styles/style-1/pages/suggest-layout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
    body: JSON.stringify(body),
  });
}

function callRoute(styleId: string, body: unknown, cookieHeader?: string) {
  return POST(req(body, cookieHeader), { params: Promise.resolve({ id: styleId }) });
}

describe('POST /api/styles/[id]/pages/suggest-layout', () => {
  it('requires login', async () => {
    const { userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const res = await callRoute(style.id, { pageName: 'Home' });
    expect(res.status).toBe(401);
  });

  it('rejects an empty pageName with a 400', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const res = await callRoute(style.id, { pageName: '' }, cookieHeader);
    expect(res.status).toBe(400);
  });

  it('suggests only active component assets, ignoring theme/image assets and soft-deleted components', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const navbar = await assetService.create({
      styleId: style.id, createdBy: userId, assetType: 'navbar', prompt: 'A navbar', imagePath: 'navbar.html', outputKind: 'component',
    });
    const footer = await assetService.create({
      styleId: style.id, createdBy: userId, assetType: 'footer', prompt: 'A footer', imagePath: 'footer.html', outputKind: 'component',
    });
    await assetService.create({
      styleId: style.id, createdBy: userId, assetType: 'theme', prompt: 'A theme', imagePath: 'theme.css', outputKind: 'theme',
    });
    const deletedComponent = await assetService.create({
      styleId: style.id, createdBy: userId, assetType: 'hero', prompt: 'A deleted hero', imagePath: 'hero.html', outputKind: 'component',
    });
    await assetService.softDelete(deletedComponent.id, userId);

    const res = await callRoute(style.id, { pageName: 'Home' }, cookieHeader);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.componentAssetIds.sort()).toEqual([navbar.id, footer.id].sort());
  });

  it('returns an empty suggestion (not an error) when the style has no components yet', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const res = await callRoute(style.id, { pageName: 'Home' }, cookieHeader);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.componentAssetIds).toEqual([]);
  });

  it('returns a 500 (not a crash) when the underlying suggester throws', async () => {
    // try/finally so a failed assertion (or setup step) still unmocks the
    // module - otherwise a mock left in place here (this file's module
    // registry, from vi.resetModules() below) could silently affect any
    // test added later in this file, producing a confusing failure
    // unrelated to what that later test actually checks.
    try {
      vi.doMock('@/lib/services/PageLayoutSuggester', async () => {
        const actual = await vi.importActual<typeof import('@/lib/services/PageLayoutSuggester')>('@/lib/services/PageLayoutSuggester');
        return {
          ...actual,
          getPageLayoutSuggester: () => ({
            suggest: async () => { throw new Error('upstream boom'); },
          }),
        };
      });
      vi.resetModules();
      const { POST: freshPost } = await import('@/app/api/styles/[id]/pages/suggest-layout/route');

      const { cookieHeader, userId } = await seedSession();
      const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
      await assetService.create({
        styleId: style.id, createdBy: userId, assetType: 'navbar', prompt: 'A navbar', imagePath: 'navbar.html', outputKind: 'component',
      });

      const res = await freshPost(req({ pageName: 'Home' }, cookieHeader), { params: Promise.resolve({ id: style.id }) });
      expect(res.status).toBe(500);
    } finally {
      vi.doUnmock('@/lib/services/PageLayoutSuggester');
      vi.resetModules();
    }
  });

  it('rejects an ollama provider without a model', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const res = await callRoute(style.id, { pageName: 'Home', provider: 'ollama' }, cookieHeader);
    expect(res.status).toBe(400);
  });

  it('passes a providerOverride through to the suggester when ollama is requested', async () => {
    // The preceding test (`returns a 500...`) calls vi.resetModules() in its
    // finally block, which orphans this file's top-level static `POST`
    // import from any module instance created by a later dynamic import().
    // Spying on a dynamically-imported PageLayoutSuggester module and then
    // calling the statically-imported POST would silently never hit the
    // spy (0 calls) -- confirmed by running it that way first. Importing a
    // fresh POST here too (same pattern as that preceding test's
    // `freshPost`) keeps it on the same module instance as the spy.
    const suggestSpy = vi.fn().mockResolvedValue([]);
    vi.spyOn(await import('@/lib/services/PageLayoutSuggester'), 'getPageLayoutSuggester').mockReturnValue({ suggest: suggestSpy });
    const { POST: freshPost } = await import('@/app/api/styles/[id]/pages/suggest-layout/route');

    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });

    await freshPost(req({
      pageName: 'Home', provider: 'ollama', model: 'llama3-groq-tool-use:8b', ollamaHost: 'http://localhost:11434',
    }, cookieHeader), { params: Promise.resolve({ id: style.id }) });

    expect(suggestSpy).toHaveBeenCalledWith('Home', expect.any(Array), undefined, {
      type: 'ollama', host: 'http://localhost:11434', model: 'llama3-groq-tool-use:8b',
    });
  });
});
