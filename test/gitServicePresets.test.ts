// test/gitServicePresets.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { presetService } from '@/lib/services/PresetService';
import { gitService } from '@/lib/services/GitService';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-gitpresets-'));
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

describe('GitService presets sync', () => {
  it('exportToJson() writes one JSON file per preset under data/presets/', async () => {
    const preset = await presetService.create({
      name: 'Landing page recipe',
      createdBy: 'user-1',
      prompt: 'a marketing landing page',
      techStackTags: JSON.stringify(['react', 'tailwind']),
      themePrompt: 'dark, minimal',
      components: JSON.stringify([{ assetType: 'hero', prompt: 'a hero section' }]),
    });
    await gitService.exportToJson();
    const filePath = path.join(tempRoot, 'data', 'presets', `preset-${preset.id}.json`);
    const content = JSON.parse(await fsPromises.readFile(filePath, 'utf-8'));
    expect(content.name).toBe('Landing page recipe');
    expect(content.theme_prompt).toBe('dark, minimal');
  });

  it('importFromJson() brings an exported preset into a fresh database', async () => {
    const preset = await presetService.create({
      name: 'Landing page recipe',
      createdBy: 'user-1',
      prompt: 'a marketing landing page',
      techStackTags: JSON.stringify(['react']),
      themePrompt: null,
      components: JSON.stringify([]),
    });
    await gitService.exportToJson();

    // Simulate a second machine: fresh DB, same exported data/ directory.
    DatabaseConnection.resetForTests();
    await gitService.importFromJson();

    const imported = await presetService.getById(preset.id);
    expect(imported?.name).toBe('Landing page recipe');
    expect(imported?.tech_stack_tags).toBe(JSON.stringify(['react']));
  });

  it('a soft-deleted preset still exports and imports (deletes propagate across machines)', async () => {
    const preset = await presetService.create({
      name: 'To be deleted',
      createdBy: 'user-1',
      prompt: 'x',
      techStackTags: '[]',
      themePrompt: null,
      components: '[]',
    });
    await presetService.softDelete(preset.id);
    await gitService.exportToJson();

    DatabaseConnection.resetForTests();
    await gitService.importFromJson();

    const imported = await presetService.getById(preset.id);
    expect(imported?.is_deleted).toBe(1);
  });
});
