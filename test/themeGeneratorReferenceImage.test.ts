// test/themeGeneratorReferenceImage.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { ClaudeApiThemeGenerator } from '@/lib/services/ClaudeApiThemeGenerator';
import { ANTHROPIC_PROVIDER } from '@/lib/services/claudeApiProviders';

let tempRoot: string;

function mockToolUseResponse() {
  return vi.fn().mockResolvedValueOnce(
    new Response(JSON.stringify({
      content: [{
        type: 'tool_use', id: 't1', name: 'emit_theme',
        input: {
          colorBackground: '#111', colorForeground: '#eee', colorAccent: '#f80', colorBorder: '#333',
          fontHeading: 'serif', fontBody: 'sans-serif', spaceUnit: '8px', radiusBase: '4px',
        },
      }],
      stop_reason: 'tool_use',
    }), { status: 200 })
  );
}

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-themerefimg-'));
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
  vi.unstubAllGlobals();
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('ClaudeApiThemeGenerator with a reference image', () => {
  it('sends an image content block alongside the text prompt when a reference image is given', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const fetchMock = mockToolUseResponse();
    vi.stubGlobal('fetch', fetchMock);

    const generator = new ClaudeApiThemeGenerator('fake-key', ANTHROPIC_PROVIDER);
    await generator.generate('match this look', style.id, { base64: 'ZmFrZQ==', mediaType: 'image/png' });

    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const content = sentBody.messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ZmFrZQ==' } });
    expect(content[1].type).toBe('text');
  });

  it('sends the prompt as a plain string (unchanged) when no reference image is given', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const fetchMock = mockToolUseResponse();
    vi.stubGlobal('fetch', fetchMock);

    const generator = new ClaudeApiThemeGenerator('fake-key', ANTHROPIC_PROVIDER);
    await generator.generate('a theme', style.id);

    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(typeof sentBody.messages[0].content).toBe('string');
  });

  it('includes basedOnContent in the prompt text when regenerating from an existing asset', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const fetchMock = mockToolUseResponse();
    vi.stubGlobal('fetch', fetchMock);

    const generator = new ClaudeApiThemeGenerator('fake-key', ANTHROPIC_PROVIDER);
    await generator.generate('make the accent brighter', style.id, undefined, ':root { --color-accent: #f80; }');

    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sentBody.messages[0].content).toContain('--color-accent: #f80');
  });
});
