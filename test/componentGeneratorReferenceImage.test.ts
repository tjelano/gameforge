import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { ClaudeApiComponentGenerator } from '@/lib/services/ComponentGenerator';
import { ANTHROPIC_PROVIDER } from '@/lib/services/claudeApiProviders';

let tempRoot: string;

function mockToolUseResponse() {
  return vi.fn().mockResolvedValueOnce(
    new Response(JSON.stringify({
      content: [{
        type: 'tool_use', id: 't1', name: 'emit_component',
        input: { html: '<button>Go</button>', css: '.x { color: red; }' },
      }],
      stop_reason: 'tool_use',
    }), { status: 200 })
  );
}

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-componentrefimg-'));
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
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  vi.unstubAllGlobals();
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('ClaudeApiComponentGenerator with a reference image', () => {
  it('sends an image content block alongside the text prompt when a reference image is given', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const fetchMock = mockToolUseResponse();
    vi.stubGlobal('fetch', fetchMock);

    const generator = new ClaudeApiComponentGenerator('fake-key', ANTHROPIC_PROVIDER);
    await generator.generate('match this button', style.id, undefined, { base64: 'ZmFrZQ==', mediaType: 'image/jpeg' });

    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const content = sentBody.messages[0].content;
    expect(content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'ZmFrZQ==' } });
  });

  it('includes basedOnContent in the prompt text when regenerating from an existing asset', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const fetchMock = mockToolUseResponse();
    vi.stubGlobal('fetch', fetchMock);

    const generator = new ClaudeApiComponentGenerator('fake-key', ANTHROPIC_PROVIDER);
    await generator.generate('make it bigger', style.id, undefined, undefined, '<button class="btn">Go</button>');

    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sentBody.messages[0].content).toContain('<button class="btn">Go</button>');
  });
});
