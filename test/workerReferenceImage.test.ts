import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { jobService } from '@/lib/services/JobService';
import { assetService } from '@/lib/services/AssetService';
import { saveReferenceImage } from '@/lib/services/referenceImage';
import * as ThemeGeneratorModule from '@/lib/services/ThemeGenerator';
import { processJob } from '../worker';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-workerrefimg-'));
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'themes'), { recursive: true });
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

describe('processJob with a reference image', () => {
  it('loads the reference image off disk and passes it to the theme generator', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const filename = await saveReferenceImage({ base64: 'ZmFrZQ==', mediaType: 'image/png' });
    const job = await jobService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'match this',
      outputKind: 'theme', options: { referenceImageFilename: filename },
    });

    const generateSpy = vi.spyOn(ThemeGeneratorModule, 'getThemeGenerator').mockReturnValue({
      generate: vi.fn().mockResolvedValue({ path: 'result.css', prompt: 'match this' }),
    } as any);

    // job.options (from jobService.create()/getById(), per JobSchema's
    // `options: z.string()`) is already the JSON-serialized options blob
    // that processJob() expects to JSON.parse() — pass the job as-is, same
    // as the raw-row jobs in workerThemeRouting.test.ts/workerValidation.test.ts.
    // (Re-JSON.stringify-ing job.options here would double-encode it into a
    // JSON string *of* a string, so options.referenceImageFilename would
    // always read back as undefined regardless of worker.ts's correctness.)
    await processJob(job);

    const generateFn = generateSpy.mock.results[0].value.generate;
    expect(generateFn).toHaveBeenCalledWith('match this', style.id, { base64: 'ZmFrZQ==', mediaType: 'image/png' }, undefined);
  });

  it('loads the based-on asset\'s current content and passes it to the theme generator', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'themes', 'existing.css'), ':root { --color-accent: #f80; }');
    const existingAsset = await assetService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x',
      imagePath: 'existing.css', outputKind: 'theme',
    });
    const job = await jobService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'brighten it',
      outputKind: 'theme', options: { basedOnAssetId: existingAsset.id },
    });

    const generateSpy = vi.spyOn(ThemeGeneratorModule, 'getThemeGenerator').mockReturnValue({
      generate: vi.fn().mockResolvedValue({ path: 'result.css', prompt: 'brighten it' }),
    } as any);

    await processJob(job);

    const generateFn = generateSpy.mock.results[0].value.generate;
    expect(generateFn).toHaveBeenCalledWith('brighten it', style.id, undefined, ':root { --color-accent: #f80; }');
  });

  it('completes normally when neither referenceImageFilename nor basedOnAssetId is set', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const job = await jobService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x', outputKind: 'theme',
    });

    const generateSpy = vi.spyOn(ThemeGeneratorModule, 'getThemeGenerator').mockReturnValue({
      generate: vi.fn().mockResolvedValue({ path: 'result.css', prompt: 'x' }),
    } as any);

    await processJob(job);

    const generateFn = generateSpy.mock.results[0].value.generate;
    expect(generateFn).toHaveBeenCalledWith('x', style.id, undefined, undefined);
  });
});
