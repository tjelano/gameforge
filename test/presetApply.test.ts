// test/presetApply.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { presetService } from '@/lib/services/PresetService';
import { styleService } from '@/lib/services/StyleService';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-presetapply-'));
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
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

async function makeFullPreset() {
  return presetService.create({
    name: 'SaaS Landing',
    createdBy: 'user-1',
    prompt: 'minimalist SaaS landing page',
    techStackTags: JSON.stringify(['Tailwind']),
    themePrompt: 'dark, indigo accent',
    components: JSON.stringify([
      { assetType: 'nav bar', prompt: 'a nav bar' },
      { assetType: 'hero section', prompt: 'a hero section' },
    ]),
  });
}

describe('presetService.applyPreset', () => {
  it('creates a new style and one job per item (theme + components), all sharing one batch_id', async () => {
    const preset = await makeFullPreset();
    const result = await presetService.applyPreset(preset.id, { newStyleName: 'My New Bible' }, 'user-2');

    expect('error' in result).toBe(false);
    if ('error' in result) return;

    const style = await styleService.getById(result.styleId);
    expect(style?.name).toBe('My New Bible');
    expect(style?.created_by).toBe('user-2');

    expect(result.jobIds).toHaveLength(3); // 1 theme + 2 components

    const db = DatabaseConnection.getInstance();
    const jobs = db.prepare('SELECT * FROM jobs WHERE style_id = ?').all(result.styleId) as any[];
    expect(jobs).toHaveLength(3);
    expect(jobs.every(j => j.batch_id === result.batchId)).toBe(true);
    expect(jobs.filter(j => j.output_kind === 'theme')).toHaveLength(1);
    expect(jobs.filter(j => j.output_kind === 'component')).toHaveLength(2);
    expect(jobs.every(j => j.status === 'pending')).toBe(true);
    expect(jobs.every(j => j.created_by === 'user-2')).toBe(true);
  });

  it('applies to an existing style without creating a new one', async () => {
    const existing = await styleService.create({ name: 'Existing Bible', createdBy: 'user-1', parameters: '{}' });
    const preset = await makeFullPreset();

    const result = await presetService.applyPreset(preset.id, { existingStyleId: existing.id }, 'user-2');
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.styleId).toBe(existing.id);

    const db = DatabaseConnection.getInstance();
    const styleCount = (db.prepare('SELECT COUNT(*) as c FROM styles').get() as { c: number }).c;
    expect(styleCount).toBe(1);
  });

  it('returns PRESET_NOT_FOUND for a nonexistent preset', async () => {
    const result = await presetService.applyPreset('00000000-0000-0000-0000-000000000000', { newStyleName: 'x' }, 'user-1');
    expect(result).toEqual({ error: 'PRESET_NOT_FOUND' });
  });

  it('returns STYLE_NOT_FOUND for a nonexistent existingStyleId', async () => {
    const preset = await makeFullPreset();
    const result = await presetService.applyPreset(preset.id, { existingStyleId: '00000000-0000-0000-0000-000000000000' }, 'user-1');
    expect(result).toEqual({ error: 'STYLE_NOT_FOUND' });
  });

  it('returns INVALID_TARGET when called directly with neither newStyleName nor existingStyleId, and creates nothing', async () => {
    // The apply API route enforces "exactly one" via a Zod .refine() before
    // ever calling this method - this test calls the service directly,
    // bypassing that route-level validation, to prove the service itself
    // is safe against a future caller that doesn't validate first.
    const preset = await makeFullPreset();
    const result = await presetService.applyPreset(preset.id, {}, 'user-1');
    expect(result).toEqual({ error: 'INVALID_TARGET' });

    const db = DatabaseConnection.getInstance();
    const styleCount = (db.prepare('SELECT COUNT(*) as c FROM styles').get() as { c: number }).c;
    expect(styleCount).toBe(0);
  });

  it('returns INVALID_TARGET when called directly with both newStyleName and existingStyleId', async () => {
    const existing = await styleService.create({ name: 'Existing', createdBy: 'user-1', parameters: '{}' });
    const preset = await makeFullPreset();
    const result = await presetService.applyPreset(preset.id, { newStyleName: 'x', existingStyleId: existing.id }, 'user-1');
    expect(result).toEqual({ error: 'INVALID_TARGET' });
  });

  it('returns NOTHING_TO_GENERATE for a preset with no theme_prompt and no components, and creates nothing', async () => {
    const preset = await presetService.create({
      name: 'Empty', createdBy: 'user-1', prompt: 'x', techStackTags: '[]', themePrompt: null, components: '[]',
    });
    const result = await presetService.applyPreset(preset.id, { newStyleName: 'Should not exist' }, 'user-1');
    expect(result).toEqual({ error: 'NOTHING_TO_GENERATE' });

    const db = DatabaseConnection.getInstance();
    const styleCount = (db.prepare('SELECT COUNT(*) as c FROM styles').get() as { c: number }).c;
    expect(styleCount).toBe(0);
  });

  it('rejects a preset with malformed components JSON', async () => {
    // Inserted directly, bypassing PresetService.create's normal flow - this
    // shape can only arise from direct DB manipulation (as here) or a future
    // bug, not from anything the app itself would write. Note: this failure
    // happens on JSON.parse, the very first statement in the transaction
    // callback, before any row is written - so it does NOT exercise rollback
    // behavior (see the next test for that).
    const db = DatabaseConnection.getInstance();
    const now = Date.now();
    const presetId = '33333333-3333-3333-3333-333333333333';
    db.prepare(`
      INSERT INTO presets (id, name, created_by, prompt, tech_stack_tags, theme_prompt, components, is_deleted, created_at, updated_at)
      VALUES (?, 'Corrupt', 'user-1', 'x', '[]', 'a theme prompt', 'not valid json', 0, ?, ?)
    `).run(presetId, now, now);

    await expect(
      presetService.applyPreset(presetId, { newStyleName: 'Should not survive' }, 'user-1')
    ).rejects.toThrow();

    const styleCount = (db.prepare('SELECT COUNT(*) as c FROM styles').get() as { c: number }).c;
    const jobCount = (db.prepare('SELECT COUNT(*) as c FROM jobs').get() as { c: number }).c;
    expect(styleCount).toBe(0);
    expect(jobCount).toBe(0);
  });

  it('rolls back the whole transaction - a mid-loop bind failure after the style and theme job are already inserted leaves zero style/job rows', async () => {
    // Inserted directly, bypassing PresetService.create's normal flow. Unlike
    // the malformed-JSON-string case above, `components` here IS valid JSON
    // (JSON.parse succeeds), so the transaction callback proceeds past the
    // parse: the style row and the theme job row both get inserted first
    // (theme_prompt is set, so the theme item is processed before any
    // component). Only then does the component loop reach an item whose
    // assetType is an object instead of a string - better-sqlite3's bind()
    // can only bind numbers, strings, bigints, buffers, and null, so the
    // component job INSERT throws a real TypeError mid-transaction. This
    // means the assertions below are only true if db.transaction() actually
    // rolls back the earlier style/theme-job inserts - without the
    // transaction wrapper, those two rows would survive.
    const db = DatabaseConnection.getInstance();
    const now = Date.now();
    const presetId = '44444444-4444-4444-4444-444444444444';
    const badComponents = JSON.stringify([{ assetType: { not: 'a string' }, prompt: 'p' }]);
    db.prepare(`
      INSERT INTO presets (id, name, created_by, prompt, tech_stack_tags, theme_prompt, components, is_deleted, created_at, updated_at)
      VALUES (?, 'Corrupt', 'user-1', 'x', '[]', 'a theme prompt', ?, 0, ?, ?)
    `).run(presetId, badComponents, now, now);

    await expect(
      presetService.applyPreset(presetId, { newStyleName: 'Should not survive' }, 'user-1')
    ).rejects.toThrow();

    const styleCount = (db.prepare('SELECT COUNT(*) as c FROM styles').get() as { c: number }).c;
    const jobCount = (db.prepare('SELECT COUNT(*) as c FROM jobs').get() as { c: number }).c;
    expect(styleCount).toBe(0);
    expect(jobCount).toBe(0);
  });
});
