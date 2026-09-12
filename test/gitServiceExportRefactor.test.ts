import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { assetService } from '@/lib/services/AssetService';
import { userService } from '@/lib/services/UserService';
import { presetService } from '@/lib/services/PresetService';
import { pageService } from '@/lib/services/PageService';
import { gitService } from '@/lib/services/GitService';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-gitexportrefactor-'));
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

describe('GitService.exportToJson() — one loop over descriptors instead of five near-identical ones', () => {
  it('writes byte-identical JSON for one of each entity type (style, asset, user, preset, page)', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const asset = await assetService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'sprite', prompt: 'a goblin', imagePath: 'goblin.png' });
    const user = await userService.create({ name: 'Alice' });
    const preset = await presetService.create({
      name: 'Landing', createdBy: 'user-1', prompt: 'p', techStackTags: '[]', themePrompt: null, components: '[]',
    });
    const page = await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });

    await gitService.exportToJson();

    const expectations: { dir: string; file: string; entity: unknown }[] = [
      { dir: 'styles', file: `style-${style.id}.json`, entity: style },
      { dir: 'assets', file: `asset-${asset.id}.json`, entity: asset },
      { dir: 'users', file: `user-${user.id}.json`, entity: user },
      { dir: 'presets', file: `preset-${preset.id}.json`, entity: preset },
      { dir: 'pages', file: `page-${page.id}.json`, entity: page },
    ];

    for (const { dir, file, entity } of expectations) {
      const content = await fsPromises.readFile(path.join(tempRoot, 'data', dir, file), 'utf-8');
      expect(content).toBe(JSON.stringify(entity, null, 2));
    }
  });
});
