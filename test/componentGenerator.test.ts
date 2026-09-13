// test/componentGenerator.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { combineComponentHtml, parseComponentHtml, MockComponentGenerator, ClaudeApiComponentGenerator } from '@/lib/services/ComponentGenerator';
import { ANTHROPIC_PROVIDER } from '@/lib/services/claudeApiProviders';
import { callOllamaTool } from '@/lib/services/ollamaToolCall';
import { styleService } from '@/lib/services/StyleService';

vi.mock('@/lib/services/ollamaToolCall', () => ({ callOllamaTool: vi.fn() }));

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-componentgen-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'components'), { recursive: true });
  setProjectRootForTests(tempRoot);
});

afterEach(async () => {
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('combineComponentHtml / parseComponentHtml round-trip', () => {
  it('recovers the original html and css after combining and re-parsing', () => {
    const original = {
      html: '<button class="btn-primary">Buy now</button>',
      css: '.btn-primary { background: var(--color-accent); }',
    };
    const combined = combineComponentHtml(original);
    expect(combined).toContain('<!DOCTYPE html>');
    expect(combined).toContain('<style>');
    const parsed = parseComponentHtml(combined);
    expect(parsed.html).toBe(original.html);
    expect(parsed.css).toBe(original.css);
  });
});

describe('MockComponentGenerator', () => {
  it('writes a real file under storage/components/ and returns its filename', async () => {
    const generator = new MockComponentGenerator();
    const result = await generator.generate('a primary button', 'style-1');
    expect(result.path).toMatch(/\.html$/);
    expect(result.prompt).toBe('a primary button');
    const filePath = path.join(tempRoot, 'storage', 'components', result.path);
    const content = await fsPromises.readFile(filePath, 'utf-8');
    expect(content).toContain('<!DOCTYPE html>');
  });
});

describe('ClaudeApiComponentGenerator', () => {
  it('calls callOllamaTool instead of callClaudeTool when a providerOverride is given', async () => {
    // getById hits a real DB via DatabaseConnection.getInstance(), which this
    // test file (unlike themeGenerator.test.ts) never provisions with
    // migrations -- stubbed here since this test only cares about provider
    // dispatch, not style lookup.
    vi.spyOn(styleService, 'getById').mockResolvedValueOnce(null);
    (callOllamaTool as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ html: '<button>Go</button>', css: '.btn{}' });
    const generator = new ClaudeApiComponentGenerator('fake-key', ANTHROPIC_PROVIDER);
    await generator.generate('a button', 'style-1', undefined, undefined, undefined, undefined, {
      type: 'ollama', host: 'http://localhost:11434', model: 'llama3-groq-tool-use:8b',
    });
    expect(callOllamaTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'emit_component' }));
  });
});
