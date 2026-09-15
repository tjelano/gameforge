import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { ClaudeApiComponentGenerator } from '@/lib/services/ComponentGenerator';
import { ANTHROPIC_PROVIDER } from '@/lib/services/claudeApiProviders';
import * as claudeToolCallModule from '@/lib/services/claudeToolCall';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-cgdelta-'));
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'components'), { recursive: true });
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  vi.restoreAllMocks();
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('ClaudeApiComponentGenerator.generate() delta path', () => {
  it('uses emit_component when basedOnContent is absent (first-generate, unchanged)', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const spy = vi.spyOn(claudeToolCallModule, 'callClaudeTool').mockResolvedValue({ html: '<button>Buy</button>', css: '.x{color:red}' });
    const gen = new ClaudeApiComponentGenerator('key', ANTHROPIC_PROVIDER);

    await gen.generate('a button', style.id);

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'emit_component' }));
  });

  it('uses emit_component_delta when basedOnContent is present', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const spy = vi.spyOn(claudeToolCallModule, 'callClaudeTool').mockResolvedValue({ mode: 'full', html: '<button>Buy</button>', css: '.x{color:red}' });
    const gen = new ClaudeApiComponentGenerator('key', ANTHROPIC_PROVIDER);

    const result = await gen.generate('make it blue', style.id, undefined, undefined, '<html>based on this</html>');

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'emit_component_delta' }));
    expect(result).toEqual({ mode: 'full', html: '<button>Buy</button>', css: '.x{color:red}' });
  });

  it('uses emit_component (not emit_component_delta) when forceFull is true, even with basedOnContent present', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const spy = vi.spyOn(claudeToolCallModule, 'callClaudeTool').mockResolvedValue({ html: '<button>Buy</button>', css: '.x{color:red}' });
    const gen = new ClaudeApiComponentGenerator('key', ANTHROPIC_PROVIDER);

    const result = await gen.generate('make it blue', style.id, undefined, undefined, '<html>based on this</html>', undefined, undefined, undefined, true);

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'emit_component' }));
    expect(result).toEqual({ mode: 'full', html: '<button>Buy</button>', css: '.x{color:red}' });
  });

  it('appends the correction text to the prompt when provided', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const spy = vi.spyOn(claudeToolCallModule, 'callClaudeTool').mockResolvedValue({ mode: 'full', html: '<button>Buy</button>', css: '.x{color:red}' });
    const gen = new ClaudeApiComponentGenerator('key', ANTHROPIC_PROVIDER);

    await gen.generate('make it blue', style.id, undefined, undefined, '<html>based on this</html>', undefined, undefined, 'Fix the missing id.');

    const call = spy.mock.calls[0][0] as any;
    expect(call.messages[0].content).toContain('Fix the missing id.');
  });

  it('rejects a response carrying fields from both discriminated-union arms', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    vi.spyOn(claudeToolCallModule, 'callClaudeTool').mockResolvedValue({ mode: 'full', html: '<button>Buy</button>', css: '.x{color:red}', patches: [] });
    const gen = new ClaudeApiComponentGenerator('key', ANTHROPIC_PROVIDER);

    await expect(gen.generate('make it blue', style.id, undefined, undefined, '<html>based on this</html>')).rejects.toThrow();
  });

  it('rejects a response missing mode entirely', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    vi.spyOn(claudeToolCallModule, 'callClaudeTool').mockResolvedValue({ html: '<button>Buy</button>', css: '.x{color:red}' });
    const gen = new ClaudeApiComponentGenerator('key', ANTHROPIC_PROVIDER);

    await expect(gen.generate('make it blue', style.id, undefined, undefined, '<html>based on this</html>')).rejects.toThrow();
  });
});
