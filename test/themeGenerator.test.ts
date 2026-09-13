// test/themeGenerator.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { MockThemeGenerator, ThemeTokensSchema, buildThemePrompt, tokensToCss, type ThemeTokens } from '@/lib/services/ThemeGenerator';
import { ClaudeApiThemeGenerator } from '@/lib/services/ClaudeApiThemeGenerator';
import { ANTHROPIC_PROVIDER } from '@/lib/services/claudeApiProviders';
import { assetService } from '@/lib/services/AssetService';

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
  vi.restoreAllMocks();
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

describe('ClaudeApiThemeGenerator', () => {
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

    const gen = new ClaudeApiThemeGenerator('fake-key', ANTHROPIC_PROVIDER);
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

    const gen = new ClaudeApiThemeGenerator('fake-key', ANTHROPIC_PROVIDER);
    const result = await gen.generate('dark fantasy, parchment and iron', STYLE_ID);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-api-key': 'fake-key' }),
        signal: expect.any(AbortSignal),
      })
    );
    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sentBody.model).toBe('claude-sonnet-5');

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

    const gen = new ClaudeApiThemeGenerator('fake-key', ANTHROPIC_PROVIDER);
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

    const gen = new ClaudeApiThemeGenerator('fake-key', ANTHROPIC_PROVIDER);
    await expect(gen.generate('x', STYLE_ID)).rejects.toThrow();
  });

  it('throws a distinct max_tokens error when the response was truncated before completing the tool call', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        id: 'msg_5', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'Thinking about the ' }],
        stop_reason: 'max_tokens',
      }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const gen = new ClaudeApiThemeGenerator('fake-key', ANTHROPIC_PROVIDER);
    await expect(gen.generate('x', STYLE_ID)).rejects.toThrow(/max_tokens/i);
  });

  it('throws with the response status when the API call itself fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);

    const gen = new ClaudeApiThemeGenerator('fake-key', ANTHROPIC_PROVIDER);
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

    const gen = new ClaudeApiThemeGenerator('fake-key', ANTHROPIC_PROVIDER);
    const NONEXISTENT_STYLE_ID = '77777777-7777-7777-7777-777777777777';
    await expect(gen.generate('x', NONEXISTENT_STYLE_ID)).resolves.toBeDefined();
  });

  it("does not steer the model away from colors that are already part of this style's own declared aesthetic", async () => {
    // Mirrors SeedThemeImporter.ts: a seed style's `parameters` is literally
    // JSON.stringify(theme.tokens) — its own promoted theme asset's colors
    // ARE the style's declared aesthetic. Telling the model to both "match"
    // and "avoid" the same color is contradictory steering (the bug this
    // fix addresses), so those colors must not end up in avoidColors.
    const SEED_TOKENS: ThemeTokens = {
      colorBackground: '#1c1a17', colorForeground: '#ede7dc', colorAccent: '#e8a33d', colorBorder: '#3c352a',
      fontHeading: "'Space Grotesk', sans-serif", fontBody: "'Inter', sans-serif", spaceUnit: '8px', radiusBase: '3px',
    };
    const SEED_STYLE_ID = '88888888-8888-8888-8888-888888888888';
    const db = DatabaseConnection.getInstance();
    db.prepare(
      `INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at)
       VALUES (?, 'seed style', 'system-seed', ?, 0, 1000, 1000)`
    ).run(SEED_STYLE_ID, JSON.stringify(SEED_TOKENS));

    const filename = 'seed-promoted.css';
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'themes', filename), tokensToCss(SEED_TOKENS));
    await assetService.create({
      styleId: SEED_STYLE_ID, createdBy: 'system-seed', assetType: 'theme',
      prompt: 'Seeded', imagePath: filename, outputKind: 'theme',
    });

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        id: 'msg_6', type: 'message', role: 'assistant',
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

    const gen = new ClaudeApiThemeGenerator('fake-key', ANTHROPIC_PROVIDER);
    await gen.generate('more like this', SEED_STYLE_ID);

    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const sentPrompt = sentBody.messages[0].content as string;
    // Both avoidColors candidates (colorBackground, colorAccent) are
    // substrings of this style's own parameters JSON, so avoidColors ends up
    // empty and the steering clause is omitted entirely.
    expect(sentPrompt).not.toContain('Avoid producing a palette');
  });

  it('falls back to generating without dedup steering when loading existing theme assets throws', async () => {
    // A malformed asset row failing Zod validation (or any other DB-level
    // failure) in getActiveThemeAssetsForStyle must not crash generation —
    // steering is best-effort, same as the per-file read/parse loop.
    vi.spyOn(assetService, 'getActiveThemeAssetsForStyle').mockRejectedValueOnce(new Error('boom'));

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        id: 'msg_7', type: 'message', role: 'assistant',
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

    const gen = new ClaudeApiThemeGenerator('fake-key', ANTHROPIC_PROVIDER);
    await expect(gen.generate('x', STYLE_ID)).resolves.toBeDefined();
  });

  it('combines a caller-supplied signal with the internal request timeout, so aborting it aborts the request', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        id: 'msg_8', type: 'message', role: 'assistant',
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

    const controller = new AbortController();
    const gen = new ClaudeApiThemeGenerator('fake-key', ANTHROPIC_PROVIDER);
    await gen.generate('x', STYLE_ID, undefined, undefined, controller.signal);

    const sentSignal = (fetchMock.mock.calls[0][1] as RequestInit).signal as AbortSignal;
    expect(sentSignal.aborted).toBe(false);
    controller.abort();
    expect(sentSignal.aborted).toBe(true);
  });
});
