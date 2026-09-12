import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { jobService } from '@/lib/services/JobService';
import * as ImageGeneratorModule from '@/lib/services/ImageGenerator';
import { processJob } from './../worker';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-sizewiring-'));
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
  vi.restoreAllMocks();
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe("worker.processJob() threads options.width/height into the image generator", () => {
  it('extracts explicit width/height from job.options and passes them to generate()', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const job = await jobService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'sprite', prompt: 'a goblin',
      outputKind: 'image', options: { width: 128, height: 32 },
    });

    const generateSpy = vi.spyOn(ImageGeneratorModule, 'getImageGenerator').mockReturnValue({
      generate: vi.fn().mockResolvedValue({ path: 'result.png', prompt: 'a goblin', metadata: { width: 128, height: 32, format: 'png' } }),
      generateUiAsset: vi.fn(),
    } as any);

    await processJob(job);

    const generateFn = generateSpy.mock.results[0].value.generate;
    expect(generateFn).toHaveBeenCalledWith('a goblin', style.id, {
      referenceImage: undefined, referenceStrength: undefined, width: 128, height: 32,
    });
  });

  it('passes width/height as undefined when omitted (unchanged existing behavior)', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const job = await jobService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'sprite', prompt: 'a goblin', outputKind: 'image',
    });

    const generateSpy = vi.spyOn(ImageGeneratorModule, 'getImageGenerator').mockReturnValue({
      generate: vi.fn().mockResolvedValue({ path: 'result.png', prompt: 'a goblin', metadata: { width: 64, height: 64, format: 'png' } }),
      generateUiAsset: vi.fn(),
    } as any);

    await processJob(job);

    const generateFn = generateSpy.mock.results[0].value.generate;
    expect(generateFn).toHaveBeenCalledWith('a goblin', style.id, {
      referenceImage: undefined, referenceStrength: undefined, width: undefined, height: undefined,
    });
  });
});
