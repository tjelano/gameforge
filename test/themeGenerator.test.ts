// test/themeGenerator.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { MockThemeGenerator, ThemeTokensSchema, buildThemePrompt } from '@/lib/services/ThemeGenerator';
import { AnthropicThemeGenerator } from '@/lib/services/AnthropicThemeGenerator';

let tempRoot: string;
const STYLE_ID = '66666666-6666-6666-6666-666666666666';

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-themegen-'));
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
     VALUES (?, 'dark fantasy', 'user-1', ?, 0, 1000, 1000)`
  ).run(STYLE_ID, JSON.stringify({ mood: 'dark fantasy, parchment and iron' }));
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  vi.unstubAllGlobals();
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('buildThemePrompt', () => {
  it('includes both the style parameters and the job prompt', () => {
    const prompt = buildThemePrompt('{"mood":"dark fantasy"}', 'more parchment texture');
    expect(prompt).toContain('dark fantasy');
    expect(prompt).toContain('more parchment texture');
  });
});

describe('ThemeTokensSchema', () => {
  it('accepts a complete, valid token set', () => {
    const result = ThemeTokensSchema.safeParse({
      colorBackground: '#1a1420',
      colorForeground: '#f0e6d2',
      colorAccent: '#e8a33d',
      colorBorder: '#4a3728',
      fontHeading: "'Cinzel', serif",
      fontBody: "'EB Garamond', serif",
      spaceUnit: '8px',
      radiusBase: '4px',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a token set missing a required field', () => {
    const result = ThemeTokensSchema.safeParse({
      colorBackground: '#1a1420',
      colorAccent: '#e8a33d',
      colorBorder: '#4a3728',
      fontHeading: "'Cinzel', serif",
      fontBody: "'EB Garamond', serif",
      spaceUnit: '8px',
      radiusBase: '4px',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a color value that attempts to break out of the CSS declaration', () => {
    const result = ThemeTokensSchema.safeParse({
      colorBackground: "red; } body { background: url('https://evil.example/x') }",
      colorForeground: '#f0e6d2',
      colorAccent: '#e8a33d',
      colorBorder: '#4a3728',
      fontHeading: "'Cinzel', serif",
      fontBody: "'EB Garamond', serif",
      spaceUnit: '8px',
      radiusBase: '4px',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a length value with no valid unit', () => {
    const result = ThemeTokensSchema.safeParse({
      colorBackground: '#1a1420', colorForeground: '#f0e6d2', colorAccent: '#e8a33d', colorBorder: '#4a3728',
      fontHeading: "'Cinzel', serif", fontBody: "'EB Garamond', serif",
      spaceUnit: '8vw', radiusBase: '4px',
    });
    expect(result.success).toBe(false);
  });
});

describe('MockThemeGenerator', () => {
  it('writes a valid, fixed CSS file under storage/themes/', async () => {
    const gen = new MockThemeGenerator();
    const result = await gen.generate('dark fantasy, parchment and iron', STYLE_ID);

    expect(result.path).toMatch(/\.css$/);
    const filePath = path.join(tempRoot, 'storage', 'themes', result.path);
    const content = await fsPromises.readFile(filePath, 'utf-8');
    expect(content).toContain(':root');
    expect(content).toContain('--color-bg');
    expect(content).toContain('--color-accent');
    expect(content).toContain('--font-heading');
    expect(content).toContain('--space-unit');
    expect(content).toContain('--radius-base');
  });

  it('gives two calls distinct filenames even with the same millisecond timestamp', async () => {
    const gen = new MockThemeGenerator();
    const [a, b] = await Promise.all([
      gen.generate('x', STYLE_ID),
      gen.generate('x', STYLE_ID),
    ]);
    expect(a.path).not.toBe(b.path);
  });
});

describe('AnthropicThemeGenerator', () => {
  it('includes the Style Bible parameters in the Anthropic request body', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant',
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
    vi.stubGlobal('fetch', fetchMock);

    const gen = new AnthropicThemeGenerator('fake-key');
    await gen.generate('more parchment texture', STYLE_ID);

    const [, requestInit] = fetchMock.mock.calls[0];
    const sentBody = JSON.parse(requestInit.body as string);
    const sentPrompt = sentBody.messages[0].content as string;
    expect(sentPrompt).toContain('dark fantasy, parchment and iron');
    expect(sentPrompt).toContain('more parchment texture');
  });

  it('sends a forced tool-use request with a timeout signal and writes the returned tokens as CSS', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant',
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
    vi.stubGlobal('fetch', fetchMock);

    const gen = new AnthropicThemeGenerator('fake-key');
    const result = await gen.generate('dark fantasy, parchment and iron', STYLE_ID);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-api-key': 'fake-key' }),
        signal: expect.any(AbortSignal),
      })
    );

    const filePath = path.join(tempRoot, 'storage', 'themes', result.path);
    const content = await fsPromises.readFile(filePath, 'utf-8');
    expect(content).toContain('--color-accent: #e8a33d;');
  });

  it('throws when the response has no tool_use block', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        id: 'msg_2', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'I refuse to use the tool.' }],
        stop_reason: 'end_turn',
      }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const gen = new AnthropicThemeGenerator('fake-key');
    await expect(gen.generate('x', STYLE_ID)).rejects.toThrow(/tool_use/i);
  });

  it('throws when the tool_use input fails ThemeTokensSchema validation', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        id: 'msg_3', type: 'message', role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool_1', name: 'emit_theme', input: { colorBackground: '#1a1420' } }],
        stop_reason: 'tool_use',
      }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const gen = new AnthropicThemeGenerator('fake-key');
    await expect(gen.generate('x', STYLE_ID)).rejects.toThrow();
  });

  it('throws with the response status when the API call itself fails', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('rate limited', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);

    const gen = new AnthropicThemeGenerator('fake-key');
    await expect(gen.generate('x', STYLE_ID)).rejects.toThrow(/429/);
  });

  it('falls back to an empty style-parameters block when the style no longer exists, without throwing', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        id: 'msg_4', type: 'message', role: 'assistant',
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
    vi.stubGlobal('fetch', fetchMock);

    const gen = new AnthropicThemeGenerator('fake-key');
    const NONEXISTENT_STYLE_ID = '77777777-7777-7777-7777-777777777777';
    await expect(gen.generate('x', NONEXISTENT_STYLE_ID)).resolves.toBeDefined();
  });
});
