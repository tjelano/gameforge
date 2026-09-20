import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { assetService } from '@/lib/services/AssetService';
import { combineComponentHtml } from '@/lib/services/componentDocument';
import { resolveComponentRegeneration } from '@/lib/services/componentPatchService';
import type { ComponentDeltaResult } from '@/lib/services/ComponentGenerator';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-regenservice-'));
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

async function mockGenerate(impl: ComponentDeltaResult | ((...args: any[]) => Promise<ComponentDeltaResult>)) {
  const generate = typeof impl === 'function' ? vi.fn(impl) : vi.fn().mockResolvedValue(impl);
  vi.spyOn(await import('@/lib/services/ComponentGenerator'), 'getComponentGenerator').mockReturnValue({
    generate,
    patchElement: vi.fn(),
  } as any);
  return generate;
}

async function seedSourceAsset(filename = 'source.html', editedExternally = false) {
  const style = await styleService.create({ name: `style-${randomUUID()}`, createdBy: 'user-1', parameters: '{}' });
  // Deliberately larger than the smallest fixture that would still carry both ids: a legitimate
  // 2-element patch batch (~77 bytes, see the "writes a successful multi-element..." test below)
  // must stay under PATCHES_BYTE_CAP_FRACTION's 50% cap of this document's own byte size, or that
  // test's genuine success case gets spuriously routed into the fallback path.
  const document = combineComponentHtml({
    html: '<div><button data-gf-id="1" class="btn">Buy now</button><span data-gf-id="2">Free shipping on every order over fifty dollars today only</span></div>',
    css: '.btn { color: blue; background: white; }',
  });
  const filePath = path.join(tempRoot, 'storage', 'components', filename);
  await fsPromises.writeFile(filePath, document);
  const asset = await assetService.create({
    styleId: style.id, createdBy: 'user-1', assetType: 'button', prompt: 'a button',
    imagePath: filename, outputKind: 'component',
  });
  if (editedExternally) {
    await assetService.update(asset.id, 'user-1', { editedExternally: true }, false);
  }
  return { filePath, document, assetId: asset.id, styleId: style.id };
}

async function seedNestedSourceAsset(filename = 'nested-source.html') {
  const style = await styleService.create({ name: `style-${randomUUID()}`, createdBy: 'user-1', parameters: '{}' });
  // Sized the same way as seedSourceAsset's fixture above (see its comment) -- large enough that
  // the vanish test's own patch batch stays under PATCHES_BYTE_CAP_FRACTION's 50% cap of this
  // document's byte size, so the vanish path is what gets exercised, not a spurious payload-cap
  // fallback.
  const document = combineComponentHtml({
    html: '<div data-gf-id="1" class="wrapper"><span data-gf-id="2">this is the original inner content before any patch gets applied here today</span></div>',
    css: '.wrapper { display: block; padding: 4px; }',
  });
  const filePath = path.join(tempRoot, 'storage', 'components', filename);
  await fsPromises.writeFile(filePath, document);
  const asset = await assetService.create({
    styleId: style.id, createdBy: 'user-1', assetType: 'button', prompt: 'a nested pair',
    imagePath: filename, outputKind: 'component',
  });
  return { filePath, document, assetId: asset.id, styleId: style.id };
}

function baseParams(source: Awaited<ReturnType<typeof seedSourceAsset>>, overrides: Partial<Parameters<typeof resolveComponentRegeneration>[0]> = {}) {
  return {
    basedOnAssetId: source.assetId,
    basedOnContent: source.document,
    instruction: 'make it blue',
    styleId: source.styleId,
    ...overrides,
  };
}

describe('resolveComponentRegeneration', () => {
  it('writes a full-mode result to a newly allocated file', async () => {
    const source = await seedSourceAsset();
    await mockGenerate({ mode: 'full', html: '<button data-gf-id="1">New</button>', css: '.x{color:red}' });

    const result = await resolveComponentRegeneration(baseParams(source));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.filename).not.toBe('source.html');
      const written = await fsPromises.readFile(path.join(tempRoot, 'storage', 'components', result.filename), 'utf-8');
      expect(written).toContain('New');
    }
  });

  it('writes a successful multi-element patches-mode result with one write, not N', async () => {
    const source = await seedSourceAsset();
    const writeSpy = vi.spyOn(fsPromises, 'writeFile');
    await mockGenerate({
      mode: 'patches',
      patches: [
        { dataGfId: '1', html: '<button data-gf-id="1">Buy now</button>', cssDeclarations: null },
        { dataGfId: '2', html: '<span data-gf-id="2">Ships free</span>', cssDeclarations: null },
      ],
    });

    const result = await resolveComponentRegeneration(baseParams(source));

    expect(result.ok).toBe(true);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    if (result.ok) {
      const written = await fsPromises.readFile(path.join(tempRoot, 'storage', 'components', result.filename), 'utf-8');
      expect(written).toContain('Buy now');
      expect(written).toContain('Ships free');
    }
  });

  it('retries once on an unresolved id, naming the offending id and a valid-id map, then succeeds', async () => {
    const source = await seedSourceAsset();
    const generate = await mockGenerate(async (...args: any[]) => {
      const correction = args[7];
      if (!correction) {
        return { mode: 'patches', patches: [{ dataGfId: '999', html: '<button data-gf-id="999">bad</button>', cssDeclarations: null }] };
      }
      expect(correction).toContain('999');
      expect(correction).toContain('"1"');
      return { mode: 'patches', patches: [{ dataGfId: '1', html: '<button data-gf-id="1">Fixed</button>', cssDeclarations: null }] };
    });

    const result = await resolveComponentRegeneration(baseParams(source));

    expect(result.ok).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('retries once on a mid-batch vanish (not just an unresolved id), and the retry can rescue it', async () => {
    // Needs an ancestor-descendant pair (id "1" contains id "2"), unlike seedSourceAsset's siblings
    // -- a vanish only happens when an earlier patch's replacement no longer contains a later
    // patch's target, which requires that nesting.
    const nested = await seedNestedSourceAsset();
    const generate = await mockGenerate(async (...args: any[]) => {
      const correction = args[7];
      if (!correction) {
        return { mode: 'patches', patches: [
          { dataGfId: '1', html: '<div data-gf-id="1">no more inner span</div>', cssDeclarations: null },
          { dataGfId: '2', html: '<span data-gf-id="2">now vanished</span>', cssDeclarations: null },
        ] };
      }
      expect(correction).toContain('2');
      return { mode: 'patches', patches: [{ dataGfId: '1', html: '<div data-gf-id="1">fixed, no vanish</div>', cssDeclarations: null }] };
    });

    const result = await resolveComponentRegeneration(baseParams(nested));

    expect(result.ok).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('accepts a retry that comes back mode:full as a normal success, not a further fallback', async () => {
    const source = await seedSourceAsset();
    const generate = await mockGenerate(async (...args: any[]) => {
      const correction = args[7];
      if (!correction) {
        return { mode: 'patches', patches: [{ dataGfId: '999', html: '<button data-gf-id="999">bad</button>', cssDeclarations: null }] };
      }
      return { mode: 'full', html: '<button data-gf-id="1">Full rewrite instead</button>', css: '' };
    });

    const result = await resolveComponentRegeneration(baseParams(source));

    expect(result.ok).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2); // initial + retry, no third (fallback) call
    if (result.ok) {
      const written = await fsPromises.readFile(path.join(tempRoot, 'storage', 'components', result.filename), 'utf-8');
      expect(written).toContain('Full rewrite instead');
    }
  });

  it('falls back to forceFull when the retry still fails, recording retry-failed', async () => {
    const source = await seedSourceAsset();
    await mockGenerate(async (...args: any[]) => {
      const forceFull = args[8];
      if (forceFull) return { mode: 'full', html: '<button data-gf-id="1">Fallback</button>', css: '' };
      return { mode: 'patches', patches: [{ dataGfId: '999', html: '<button data-gf-id="999">still bad</button>', cssDeclarations: null }] };
    });

    const result = await resolveComponentRegeneration(baseParams(source));

    expect(result.ok).toBe(true);
    if (result.ok) {
      const written = await fsPromises.readFile(path.join(tempRoot, 'storage', 'components', result.filename), 'utf-8');
      expect(written).toContain('Fallback');
    }
  });

  it('falls straight to fallback on a sanitize failure in patches mode, skipping the retry', async () => {
    const source = await seedSourceAsset();
    const generate = await mockGenerate(async (...args: any[]) => {
      const forceFull = args[8];
      if (forceFull) return { mode: 'full', html: '<button data-gf-id="1">Fallback</button>', css: '' };
      return { mode: 'patches', patches: [{ dataGfId: '1', html: '<button data-gf-id="1">Buy</button></style><script>bad</script>', cssDeclarations: null }] };
    });

    const result = await resolveComponentRegeneration(baseParams(source));

    expect(result.ok).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2); // original attempt + fallback, no retry
  });

  it('falls back on an empty patch list without a retry', async () => {
    const source = await seedSourceAsset();
    const generate = await mockGenerate(async (...args: any[]) => {
      const forceFull = args[8];
      if (forceFull) return { mode: 'full', html: '<button data-gf-id="1">Fallback</button>', css: '' };
      return { mode: 'patches', patches: [] };
    });

    const result = await resolveComponentRegeneration(baseParams(source));

    expect(result.ok).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('falls back on a duplicate dataGfId without a retry', async () => {
    const source = await seedSourceAsset();
    const generate = await mockGenerate(async (...args: any[]) => {
      const forceFull = args[8];
      if (forceFull) return { mode: 'full', html: '<button data-gf-id="1">Fallback</button>', css: '' };
      return { mode: 'patches', patches: [
        { dataGfId: '1', html: '<button data-gf-id="1">A</button>', cssDeclarations: null },
        { dataGfId: '1', html: '<button data-gf-id="1">B</button>', cssDeclarations: null },
      ] };
    });

    const result = await resolveComponentRegeneration(baseParams(source));

    expect(result.ok).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('falls back when the patch batch exceeds the count cap', async () => {
    const source = await seedSourceAsset();
    const bigBatch = Array.from({ length: 21 }, (_, i) => ({ dataGfId: '1', html: '<button data-gf-id="1">x</button>', cssDeclarations: null }));
    const generate = await mockGenerate(async (...args: any[]) => {
      const forceFull = args[8];
      if (forceFull) return { mode: 'full', html: '<button data-gf-id="1">Fallback</button>', css: '' };
      return { mode: 'patches', patches: bigBatch };
    });

    const result = await resolveComponentRegeneration(baseParams(source));

    expect(result.ok).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('falls back when the patch batch exceeds the byte cap', async () => {
    const source = await seedSourceAsset();
    const hugeHtml = `<button data-gf-id="1">${'x'.repeat(5000)}</button>`;
    const generate = await mockGenerate(async (...args: any[]) => {
      const forceFull = args[8];
      if (forceFull) return { mode: 'full', html: '<button data-gf-id="1">Fallback</button>', css: '' };
      return { mode: 'patches', patches: [{ dataGfId: '1', html: hugeHtml, cssDeclarations: null }] };
    });

    const result = await resolveComponentRegeneration(baseParams(source));

    expect(result.ok).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('falls back when basedOnContent does not parse in patches mode', async () => {
    const source = await seedSourceAsset();
    const unparseableContent = 'not a real component document';
    // The on-disk file must actually hold this same (unparseable) content too -- Step 10's
    // staleness recheck hashes the file it re-reads against a hash of basedOnContent itself, so a
    // basedOnContent that diverges from disk would trip that unrelated check before this test's
    // intended unparseable-source fallback path is ever observed.
    await fsPromises.writeFile(source.filePath, unparseableContent);
    const generate = await mockGenerate(async (...args: any[]) => {
      const forceFull = args[8];
      if (forceFull) return { mode: 'full', html: '<button data-gf-id="1">Fallback</button>', css: '' };
      return { mode: 'patches', patches: [{ dataGfId: '1', html: '<button data-gf-id="1">x</button>', cssDeclarations: null }] };
    });

    const result = await resolveComponentRegeneration(baseParams(source, { basedOnContent: unparseableContent }));

    expect(result.ok).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('routes a malformed tool response (thrown ZodError) to the fallback, not a hard failure', async () => {
    const source = await seedSourceAsset();
    const { ZodError, z } = await import('zod');
    let call = 0;
    const generate = await mockGenerate(async (...args: any[]) => {
      call += 1;
      const forceFull = args[8];
      if (forceFull) return { mode: 'full', html: '<button data-gf-id="1">Fallback</button>', css: '' };
      // Simulate generate() throwing a ZodError on the first call.
      throw new ZodError([{ code: 'custom', path: ['mode'], message: 'invalid' } as any]);
    });

    const result = await resolveComponentRegeneration(baseParams(source));

    expect(result.ok).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('never attempts patches mode when the based-on asset is edited_externally, for a style-sounding instruction', async () => {
    const source = await seedSourceAsset('source.html', true);
    const generate = await mockGenerate({ mode: 'full', html: '<button data-gf-id="1">Full</button>', css: '' });

    const result = await resolveComponentRegeneration(baseParams(source, { instruction: 'just make the button a bit bluer' }));

    expect(result.ok).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    const call = generate.mock.calls[0];
    expect(call[8]).toBe(true); // forceFull
  });

  it('never attempts patches mode when the based-on asset is edited_externally, even for a plain instruction with no style/structure signal either way', async () => {
    const source = await seedSourceAsset('source.html', true);
    const generate = await mockGenerate({ mode: 'full', html: '<button data-gf-id="1">Full</button>', css: '' });

    const result = await resolveComponentRegeneration(baseParams(source, { instruction: 'update this component' }));

    expect(result.ok).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    const call = generate.mock.calls[0];
    expect(call[8]).toBe(true); // forceFull -- trust overrides regardless of what the instruction sounds like
  });

  it('fails with a sanitize message on a bad mode:full response, not a fallback', async () => {
    const source = await seedSourceAsset();
    await mockGenerate({ mode: 'full', html: '<script>bad</script>', css: '@import "evil";' });

    const result = await resolveComponentRegeneration(baseParams(source));

    expect(result.ok).toBe(false);
  });

  it('fails closed with the staleness message when the based-on file changes during the AI call', async () => {
    const source = await seedSourceAsset();
    await mockGenerate(async () => {
      await fsPromises.writeFile(source.filePath, combineComponentHtml({ html: '<button data-gf-id="1">Changed underneath</button>', css: '' }));
      return { mode: 'full', html: '<button data-gf-id="1">New</button>', css: '' };
    });

    const result = await resolveComponentRegeneration(baseParams(source));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('changed while regenerating');
    const filesAfter = await fsPromises.readdir(path.join(tempRoot, 'storage', 'components'));
    expect(filesAfter).toEqual(['source.html']); // no new file written
  });

  it('fails closed with the staleness message when edited_externally flips during the AI call, even if bytes are unchanged', async () => {
    const source = await seedSourceAsset();
    await mockGenerate(async () => {
      await assetService.update(source.assetId, 'user-1', { editedExternally: true }, false);
      return { mode: 'full', html: '<button data-gf-id="1">New</button>', css: '' };
    });

    const result = await resolveComponentRegeneration(baseParams(source));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('changed while regenerating');
  });

  it('fails closed instead of recursing if a forceFull fallback call ever returns mode:patches (defensive guard against a future generate() regression)', async () => {
    const source = await seedSourceAsset();
    const generate = await mockGenerate(async () => {
      // Always returns patches mode, even under forceFull -- simulates a hypothetical future
      // regression in generate() that violates its own "forceFull:true only returns mode:'full'"
      // contract, which runFallback() must not trust blindly.
      return { mode: 'patches', patches: [{ dataGfId: '999', html: '<button data-gf-id="999">x</button>', cssDeclarations: null }] };
    });

    const result = await resolveComponentRegeneration(baseParams(source));

    expect(result.ok).toBe(false);
    // initial attempt (unresolved id "999") -> one retry (still unresolved) -> one fallback
    // attempt (still mode:'patches', caught by the new guard) -- exactly 3 calls, then it stops.
    expect(generate).toHaveBeenCalledTimes(3);
  });
});
