// test/presetService.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { presetService } from '@/lib/services/PresetService';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-presetservice-'));
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

describe('PresetService', () => {
  it('creates a preset and reads it back', async () => {
    const preset = await presetService.create({
      name: 'SaaS Landing',
      createdBy: 'user-1',
      prompt: 'minimalist SaaS landing page, dark mode',
      techStackTags: JSON.stringify(['Tailwind', 'React']),
      themePrompt: 'dark, high-contrast, indigo accent',
      components: JSON.stringify([{ assetType: 'nav bar', prompt: 'a nav bar' }]),
    });
    expect(preset.name).toBe('SaaS Landing');
    expect(preset.is_deleted).toBe(0);

    const fetched = await presetService.getById(preset.id);
    expect(fetched?.id).toBe(preset.id);
  });

  it('getActivePresets excludes soft-deleted presets, newest first', async () => {
    const first = await presetService.create({
      name: 'First', createdBy: 'user-1', prompt: 'x', techStackTags: '[]', themePrompt: null, components: '[]',
    });
    const second = await presetService.create({
      name: 'Second', createdBy: 'user-1', prompt: 'x', techStackTags: '[]', themePrompt: null, components: '[]',
    });
    await presetService.softDelete(first.id);

    const active = await presetService.getActivePresets();
    expect(active.map(p => p.id)).toEqual([second.id]);
  });

  it('update() has no ownership check - any caller can edit any preset', async () => {
    const preset = await presetService.create({
      name: 'Original', createdBy: 'user-1', prompt: 'x', techStackTags: '[]', themePrompt: null, components: '[]',
    });
    const updated = await presetService.update(preset.id, { name: 'Renamed by someone else' });
    expect(updated?.name).toBe('Renamed by someone else');
  });

  it('update() returns null for a nonexistent preset', async () => {
    const result = await presetService.update('00000000-0000-0000-0000-000000000000', { name: 'x' });
    expect(result).toBeNull();
  });

  it('softDelete() flips is_deleted to 1', async () => {
    const preset = await presetService.create({
      name: 'x', createdBy: 'user-1', prompt: 'x', techStackTags: '[]', themePrompt: null, components: '[]',
    });
    await presetService.softDelete(preset.id);
    const fetched = await presetService.getById(preset.id);
    expect(fetched?.is_deleted).toBe(1);
  });
});
