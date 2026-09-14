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

function mockPatchToolUseResponse(input: Record<string, unknown>) {
  return vi.fn().mockResolvedValueOnce(
    new Response(JSON.stringify({
      content: [{
        type: 'tool_use', id: 't1', name: 'emit_element_patch',
        input,
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

  it('combines a caller-supplied signal with the internal request timeout', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const fetchMock = mockToolUseResponse();
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    const generator = new ClaudeApiComponentGenerator('fake-key', ANTHROPIC_PROVIDER);
    await generator.generate('a button', style.id, undefined, undefined, undefined, controller.signal);

    const sentSignal = (fetchMock.mock.calls[0][1] as RequestInit).signal as AbortSignal;
    expect(sentSignal.aborted).toBe(false);
    controller.abort();
    expect(sentSignal.aborted).toBe(true);
  });
});

describe('ClaudeApiComponentGenerator error paths', () => {
  it('throws when the response has no tool_use block', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        content: [{ type: 'text', text: 'I refuse to use the tool.' }],
        stop_reason: 'end_turn',
      }), { status: 200 })
    ));

    const generator = new ClaudeApiComponentGenerator('fake-key', ANTHROPIC_PROVIDER);
    await expect(generator.generate('a button', style.id)).rejects.toThrow(/tool_use/i);
  });

  it('throws when the tool_use input fails html/css schema validation', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        content: [{ type: 'tool_use', id: 't1', name: 'emit_component', input: { html: '<button>Go</button>' } }], // missing css
        stop_reason: 'tool_use',
      }), { status: 200 })
    ));

    const generator = new ClaudeApiComponentGenerator('fake-key', ANTHROPIC_PROVIDER);
    await expect(generator.generate('a button', style.id)).rejects.toThrow();
  });

  it('throws a distinct max_tokens error when the response was truncated before completing the tool call', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        content: [{ type: 'text', text: 'Thinking about the ' }],
        stop_reason: 'max_tokens',
      }), { status: 200 })
    ));

    const generator = new ClaudeApiComponentGenerator('fake-key', ANTHROPIC_PROVIDER);
    await expect(generator.generate('a button', style.id)).rejects.toThrow(/max_tokens/i);
  });

  it('throws with the response status when the API call itself fails', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 })));

    const generator = new ClaudeApiComponentGenerator('fake-key', ANTHROPIC_PROVIDER);
    await expect(generator.generate('a button', style.id)).rejects.toThrow(/429/);
  });
});

describe("ClaudeApiComponentGenerator sanitizes the raw model output before writing", () => {
  it("writes html with a disallowed attribute/tag stripped, not the model's raw output", async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        content: [{
          type: 'tool_use', id: 't1', name: 'emit_component',
          input: {
            html: '<button onclick="alert(1)">Go</button><script>alert(2)</script>',
            css: '.x { color: var(--color-accent); }',
          },
        }],
        stop_reason: 'tool_use',
      }), { status: 200 })
    ));

    const generator = new ClaudeApiComponentGenerator('fake-key', ANTHROPIC_PROVIDER);
    const result = await generator.generate('a button', style.id);

    const filePath = path.join(tempRoot, 'storage', 'components', result.path);
    const content = await fsPromises.readFile(filePath, 'utf-8');
    expect(content).not.toContain('onclick');
    expect(content).not.toContain('<script>');
    expect(content).toContain('<button data-gf-id="1">Go</button>');
  });
});

describe('ClaudeApiComponentGenerator.patchElement', () => {
  it('returns sanitized html and css declarations from the tool call', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    vi.stubGlobal('fetch', mockPatchToolUseResponse({
      html: '<button class="btn">New</button>',
      cssDeclarations: 'color: blue;',
    }));

    const generator = new ClaudeApiComponentGenerator('fake-key', ANTHROPIC_PROVIDER);
    const result = await generator.patchElement(
      '<button class="btn">Old</button>',
      'make it say New',
      'color: red;',
      style.id,
    );

    expect(result.html).toContain('New');
    expect(result.cssDeclarations).toBe('color: blue;');
  });

  it('sanitizes the returned html fragment', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    vi.stubGlobal('fetch', mockPatchToolUseResponse({
      html: '<script>alert(1)</script><button>ok</button>',
    }));

    const generator = new ClaudeApiComponentGenerator('fake-key', ANTHROPIC_PROVIDER);
    const result = await generator.patchElement(
      '<button>old</button>',
      'remove the script',
      null,
      style.id,
    );

    // 'ok' only appears in the mocked AI response, not the input element ('old') --
    // proves this is the (sanitized) AI response, not the input passed through unchanged.
    expect(result.html).toContain('ok');
    expect(result.html).not.toContain('script');
  });

  it('passes null cssDeclarations through when the AI makes no style change', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    vi.stubGlobal('fetch', mockPatchToolUseResponse({ html: '<button>ok</button>' }));

    const generator = new ClaudeApiComponentGenerator('fake-key', ANTHROPIC_PROVIDER);
    const result = await generator.patchElement(
      '<button>old</button>',
      'just change the text',
      null,
      style.id,
    );

    expect(result.cssDeclarations).toBeNull();
  });
});
