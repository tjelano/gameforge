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
import * as ImageGeneratorModule from '@/lib/services/ImageGenerator';
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
    expect(generateFn).toHaveBeenCalledWith('match this', style.id, { base64: 'ZmFrZQ==', mediaType: 'image/png' }, undefined, undefined, undefined);
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
    expect(generateFn).toHaveBeenCalledWith('brighten it', style.id, undefined, ':root { --color-accent: #f80; }', undefined, undefined);
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
    expect(generateFn).toHaveBeenCalledWith('x', style.id, undefined, undefined, undefined, undefined);
  });
});

describe('processJob sprite regeneration falls back to the based-on asset\'s own image', () => {
  it('loads the based-on sprite asset\'s stored image and passes it as the reference when no fresh upload was attached', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await fsPromises.mkdir(path.join(tempRoot, 'storage', 'images'), { recursive: true });
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'images', 'existing.png'), 'fake-sprite-bytes');
    const existingAsset = await assetService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'sprite', prompt: 'a goblin',
      imagePath: 'existing.png', outputKind: 'image',
    });
    const job = await jobService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'sprite', prompt: 'a goblin, angrier',
      outputKind: 'image', options: { basedOnAssetId: existingAsset.id },
    });

    const generateSpy = vi.spyOn(ImageGeneratorModule, 'getImageGenerator').mockReturnValue({
      generate: vi.fn().mockResolvedValue({ path: 'result.png', prompt: 'a goblin, angrier', metadata: { width: 64, height: 64, format: 'png' } }),
      generateUiAsset: vi.fn(),
    } as any);

    await processJob(job);

    const generateFn = generateSpy.mock.results[0].value.generate;
    expect(generateFn).toHaveBeenCalledWith('a goblin, angrier', style.id, {
      referenceImage: { base64: Buffer.from('fake-sprite-bytes').toString('base64'), mediaType: 'image/png' },
      referenceStrength: undefined,
    });
  });

  it('prefers a freshly-uploaded reference image over the based-on asset\'s own image', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await fsPromises.mkdir(path.join(tempRoot, 'storage', 'images'), { recursive: true });
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'images', 'existing.png'), 'fake-sprite-bytes');
    const existingAsset = await assetService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'sprite', prompt: 'a goblin',
      imagePath: 'existing.png', outputKind: 'image',
    });
    const filename = await saveReferenceImage({ base64: 'ZnJlc2g=', mediaType: 'image/jpeg' });
    const job = await jobService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'sprite', prompt: 'a goblin, angrier',
      outputKind: 'image', options: { basedOnAssetId: existingAsset.id, referenceImageFilename: filename },
    });

    const generateSpy = vi.spyOn(ImageGeneratorModule, 'getImageGenerator').mockReturnValue({
      generate: vi.fn().mockResolvedValue({ path: 'result.png', prompt: 'a goblin, angrier', metadata: { width: 64, height: 64, format: 'png' } }),
      generateUiAsset: vi.fn(),
    } as any);

    await processJob(job);

    const generateFn = generateSpy.mock.results[0].value.generate;
    expect(generateFn).toHaveBeenCalledWith('a goblin, angrier', style.id, {
      referenceImage: { base64: 'ZnJlc2g=', mediaType: 'image/jpeg' },
      referenceStrength: undefined,
    });
  });

  it('completes normally when the based-on asset is a theme/component (no image to fall back to)', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'themes', 'existing.css'), ':root {}');
    const existingAsset = await assetService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x',
      imagePath: 'existing.css', outputKind: 'theme',
    });
    const job = await jobService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'sprite', prompt: 'a goblin',
      outputKind: 'image', options: { basedOnAssetId: existingAsset.id },
    });

    const generateSpy = vi.spyOn(ImageGeneratorModule, 'getImageGenerator').mockReturnValue({
      generate: vi.fn().mockResolvedValue({ path: 'result.png', prompt: 'a goblin', metadata: { width: 64, height: 64, format: 'png' } }),
      generateUiAsset: vi.fn(),
    } as any);

    await processJob(job);

    const generateFn = generateSpy.mock.results[0].value.generate;
    expect(generateFn).toHaveBeenCalledWith('a goblin', style.id, { referenceImage: undefined, referenceStrength: undefined });
  });
});
