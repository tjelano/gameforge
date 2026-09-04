// test/getThemeGeneratorSelection.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';

let tempRoot: string;
const STYLE_ID = '88888888-8888-8888-8888-888888888888';

function mockFetchOnce() {
  return vi.fn().mockResolvedValueOnce(
    new Response(JSON.stringify({
      content: [{
        type: 'tool_use', id: 'tool_1', name: 'emit_theme',
        input: {
          colorBackground: '#1a1420', colorForeground: '#f0e6d2', colorAccent: '#e8a33d', colorBorder: '#4a3728',
          fontHeading: "'Cinzel', serif", fontBody: "'EB Garamond', serif", spaceUnit: '8px', radiusBase: '4px',
        },
      }],
      stop_reason: 'tool_use',
    }), { status: 200 })
  );
}

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-themeselect-'));
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
  const db = DatabaseConnection.getInstance();
  db.prepare(
    `INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at)
     VALUES (?, 'style', 'user-1', '{}', 0, 1000, 1000)`
  ).run(STYLE_ID);

  vi.resetModules();
  vi.unstubAllEnvs();
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('getThemeGenerator() provider selection', () => {
  it('defaults to MockThemeGenerator when THEME_API_PROVIDER and ANTHROPIC_API_KEY are both unset', async () => {
    const { getThemeGenerator, MockThemeGenerator } = await import('@/lib/services/ThemeGenerator');
    const gen = getThemeGenerator();
    expect(gen).toBeInstanceOf(MockThemeGenerator);
  });

  it('routes to the official Anthropic endpoint when THEME_API_PROVIDER is unset but ANTHROPIC_API_KEY is set', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'fake-anthropic-key');
    const fetchMock = mockFetchOnce();
    vi.stubGlobal('fetch', fetchMock);

    const { getThemeGenerator } = await import('@/lib/services/ThemeGenerator');
    await getThemeGenerator().generate('x', STYLE_ID);

    expect(fetchMock).toHaveBeenCalledWith('https://api.anthropic.com/v1/messages', expect.anything());
  });

  it('routes to cheaperinference.com when THEME_API_PROVIDER=cheaperinference and its key is set', async () => {
    vi.stubEnv('THEME_API_PROVIDER', 'cheaperinference');
    vi.stubEnv('CHEAPERINFERENCE_API_KEY', 'fake-ci-key');
    const fetchMock = mockFetchOnce();
    vi.stubGlobal('fetch', fetchMock);

    const { getThemeGenerator } = await import('@/lib/services/ThemeGenerator');
    await getThemeGenerator().generate('x', STYLE_ID);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.cheaperinference.com/v1/messages',
      expect.objectContaining({ headers: expect.objectContaining({ 'X-Api-Key': 'fake-ci-key' }) })
    );
  });

  it('routes to kie.ai when THEME_API_PROVIDER=kieai and its key is set', async () => {
    vi.stubEnv('THEME_API_PROVIDER', 'kieai');
    vi.stubEnv('KIEAI_API_KEY', 'fake-kieai-key');
    const fetchMock = mockFetchOnce();
    vi.stubGlobal('fetch', fetchMock);

    const { getThemeGenerator } = await import('@/lib/services/ThemeGenerator');
    await getThemeGenerator().generate('x', STYLE_ID);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.kie.ai/claude/v1/messages',
      expect.objectContaining({ headers: expect.objectContaining({ ANTHROPIC_AUTH_TOKEN: 'fake-kieai-key' }) })
    );
  });

  it('throws a clear error when THEME_API_PROVIDER=cheaperinference but CHEAPERINFERENCE_API_KEY is missing', async () => {
    vi.stubEnv('THEME_API_PROVIDER', 'cheaperinference');
    const { getThemeGenerator } = await import('@/lib/services/ThemeGenerator');
    expect(() => getThemeGenerator()).toThrow(/CHEAPERINFERENCE_API_KEY/);
  });

  it('throws a clear error when THEME_API_PROVIDER=kieai but KIEAI_API_KEY is missing', async () => {
    vi.stubEnv('THEME_API_PROVIDER', 'kieai');
    const { getThemeGenerator } = await import('@/lib/services/ThemeGenerator');
    expect(() => getThemeGenerator()).toThrow(/KIEAI_API_KEY/);
  });

  it('throws a clear error for an unrecognized THEME_API_PROVIDER value', async () => {
    vi.stubEnv('THEME_API_PROVIDER', 'not-a-real-provider');
    const { getThemeGenerator } = await import('@/lib/services/ThemeGenerator');
    expect(() => getThemeGenerator()).toThrow(/not-a-real-provider/);
  });
});
