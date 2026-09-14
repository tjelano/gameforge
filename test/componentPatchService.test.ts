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
import { hashDocument } from '@/lib/services/componentElementTree';
import { applyElementPatch } from '@/lib/services/componentPatchService';
import type { PatchedElement } from '@/lib/services/ComponentGenerator';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-patchservice-'));
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

/** Mocks getComponentGenerator() the same way test/workerThemeRouting.test.ts does. */
async function mockPatchElement(result: PatchedElement | ((...args: any[]) => Promise<PatchedElement>)) {
  const patchElement = typeof result === 'function' ? vi.fn(result) : vi.fn().mockResolvedValue(result);
  vi.spyOn(await import('@/lib/services/ComponentGenerator'), 'getComponentGenerator').mockReturnValue({
    generate: vi.fn(),
    patchElement,
  });
  return patchElement;
}

/** Seeds storage/components/<filename> with a single-button fixture (data-gf-id="1", the only id in the doc) and a matching asset row. Returns the fixture's initial document string, hash, and ids needed to call applyElementPatch. */
async function seedFixture(filename = 'fixture.html'): Promise<{
  filePath: string;
  document: string;
  documentHash: string;
  assetId: string;
  styleId: string;
}> {
  const style = await styleService.create({ name: `style-${randomUUID()}`, createdBy: 'user-1', parameters: '{}' });
  const document = combineComponentHtml({
    html: '<button data-gf-id="1" class="btn">Buy now</button>',
    css: '.btn { color: blue; }',
  });
  const filePath = path.join(tempRoot, 'storage', 'components', filename);
  await fsPromises.writeFile(filePath, document);
  const asset = await assetService.create({
    styleId: style.id,
    createdBy: 'user-1',
    assetType: 'button',
    prompt: 'a button',
    imagePath: filename,
    outputKind: 'component',
  });
  return { filePath, document, documentHash: hashDocument(document), assetId: asset.id, styleId: style.id };
}

function baseParams(fixture: Awaited<ReturnType<typeof seedFixture>>, overrides: Partial<Parameters<typeof applyElementPatch>[0]> = {}) {
  return {
    filename: 'fixture.html',
    assetId: fixture.assetId,
    requestingUserId: 'user-1',
    isAdmin: false,
    dataGfId: '1',
    documentHash: fixture.documentHash,
    instruction: 'make it blue',
    styleId: fixture.styleId,
    ...overrides,
  };
}

describe('applyElementPatch', () => {
  it('splices a successful patch into storage and returns the new document hash', async () => {
    const fixture = await seedFixture();
    await mockPatchElement({ html: '<button data-gf-id="1">Buy now</button>', cssDeclarations: 'color: blue;' });

    const result = await applyElementPatch(baseParams(fixture));

    expect(result.ok).toBe(true);
    if (result.ok) {
      const stored = await fsPromises.readFile(fixture.filePath, 'utf-8');
      expect(stored).toContain('gf-1'); // the assigned class
      expect(hashDocument(stored)).toBe(result.newDocumentHash); // returned hash matches what's actually on disk
      expect(hashDocument(stored)).not.toBe(fixture.documentHash); // and it changed vs. the original
      expect(result.idMap.rootId).toBe('1');
    }
  });

  it('returns ELEMENT_CHANGED when the sent documentHash is stale (pre-AI-call check)', async () => {
    const fixture = await seedFixture();
    const patchElement = await mockPatchElement({ html: '<button data-gf-id="1">Buy now</button>', cssDeclarations: null });

    const result = await applyElementPatch(baseParams(fixture, { documentHash: 'wrong-hash' }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ELEMENT_CHANGED');
    expect(patchElement).not.toHaveBeenCalled();
  });

  it('returns ELEMENT_NOT_FOUND for a missing dataGfId', async () => {
    const fixture = await seedFixture();
    const patchElement = await mockPatchElement({ html: '<button data-gf-id="1">Buy now</button>', cssDeclarations: null });

    const result = await applyElementPatch(baseParams(fixture, { dataGfId: '999' }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ELEMENT_NOT_FOUND');
    expect(patchElement).not.toHaveBeenCalled();
  });

  it('returns COMPONENT_NOT_FOUND when the file does not exist', async () => {
    const fixture = await seedFixture();
    await mockPatchElement({ html: '<button data-gf-id="1">Buy now</button>', cssDeclarations: null });

    const result = await applyElementPatch(baseParams(fixture, { filename: 'does-not-exist.html' }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('COMPONENT_NOT_FOUND');
  });

  it('preserves the target data-gf-id and assigns fresh ids to any new descendants', async () => {
    const fixture = await seedFixture();
    await mockPatchElement({
      html: '<button data-gf-id="1">Buy now <span>New!</span></button>',
      cssDeclarations: null,
    });

    const result = await applyElementPatch(baseParams(fixture));

    expect(result.ok).toBe(true);
    const stored = await fsPromises.readFile(fixture.filePath, 'utf-8');
    expect(stored).toContain('data-gf-id="1"'); // target unchanged
    expect(stored).toContain('data-gf-id="2"'); // fresh id for the new descendant, starting at max(existing)+1
    if (result.ok) {
      expect(result.idMap.newDescendantIds).toEqual(['2']);
    }
  });

  it('replaces (not accumulates) a second patch to the same element', async () => {
    const fixture = await seedFixture();
    await mockPatchElement({ html: '<button data-gf-id="1">Buy now</button>', cssDeclarations: 'color: blue;' });
    const result1 = await applyElementPatch(baseParams(fixture, { instruction: 'make it blue' }));
    expect(result1.ok).toBe(true);
    if (!result1.ok) throw new Error('expected first patch to succeed');

    await mockPatchElement({ html: '<button data-gf-id="1">Buy now</button>', cssDeclarations: 'color: red;' });
    const result2 = await applyElementPatch(baseParams(fixture, {
      instruction: 'make it red',
      documentHash: result1.newDocumentHash,
    }));
    expect(result2.ok).toBe(true);

    const stored = await fsPromises.readFile(fixture.filePath, 'utf-8');
    const ruleMatches = [...stored.matchAll(/\.gf-1\s*\{/g)];
    expect(ruleMatches.length).toBe(1); // exactly one rule for this element, not two
    const gf1Rule = stored.match(/\.gf-1\s*\{[^}]*\}/)?.[0];
    expect(gf1Rule).toContain('color: red');
    expect(gf1Rule).not.toContain('color: blue'); // the earlier patch's declarations were replaced wholesale, not merged
  });

  it('rejects a fragment containing a literal </body> before splicing (not just on round-trip failure)', async () => {
    const fixture = await seedFixture();
    const patchElement = await mockPatchElement({
      html: '<button data-gf-id="1" title="x</body>y">Buy now</button>',
      cssDeclarations: null,
    });

    const result = await applyElementPatch(baseParams(fixture));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SANITIZE_REJECTED');
    expect(patchElement).toHaveBeenCalled(); // the AI call did happen; this is a post-call, pre-splice check
    const stored = await fsPromises.readFile(fixture.filePath, 'utf-8');
    expect(stored).toBe(fixture.document); // no write occurred
  });

  it('updates the asset prompt with the patch instruction, does not set editedExternally', async () => {
    const fixture = await seedFixture();
    await mockPatchElement({ html: '<button data-gf-id="1">Buy now</button>', cssDeclarations: null });

    const result = await applyElementPatch(baseParams(fixture, { instruction: 'make it blue' }));

    expect(result.ok).toBe(true);
    const asset = await assetService.getById(fixture.assetId);
    expect(asset?.prompt).toContain('make it blue');
    expect(asset?.edited_externally).toBeFalsy();
  });

  it('serializes two concurrent patches to the same file without holding the lock across the AI call', async () => {
    // Both calls share the same (initially valid) documentHash and both should reach the AI
    // mock concurrently -- if the lock were held across the AI call, the second call's mock
    // invocation would be delayed until the first fully completes (write included). Instead,
    // both AI calls fire, and only the SECOND one to reach the locked re-check should lose to
    // a since-changed hash.
    const fixture = await seedFixture();
    let inFlight = 0;
    let sawConcurrentCalls = false;
    const patchElement = await mockPatchElement(async () => {
      inFlight += 1;
      if (inFlight === 2) sawConcurrentCalls = true;
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return { html: '<button data-gf-id="1">Buy now</button>', cssDeclarations: 'color: green;' };
    });

    const [r1, r2] = await Promise.all([
      applyElementPatch(baseParams(fixture, { instruction: 'call A' })),
      applyElementPatch(baseParams(fixture, { instruction: 'call B' })),
    ]);

    expect(patchElement).toHaveBeenCalledTimes(2);
    expect(sawConcurrentCalls).toBe(true); // proves the mutex was NOT held across the AI call
    const results = [r1, r2];
    const succeeded = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    expect(succeeded.length).toBe(1); // exactly one writer wins
    expect(failed.length).toBe(1);
    if (!failed[0].ok) expect(failed[0].error.code).toBe('ELEMENT_CHANGED');

    const stored = await fsPromises.readFile(fixture.filePath, 'utf-8');
    // The file is well-formed (parses cleanly), proving no interleaved/torn write occurred.
    expect(stored).toContain('data-gf-id="1"');
    expect(stored.match(/data-gf-id="1"/g)?.length).toBe(1);
  });
});
