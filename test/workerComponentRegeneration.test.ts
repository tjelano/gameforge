import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { jobService } from '@/lib/services/JobService';
import { assetService } from '@/lib/services/AssetService';
import * as ComponentPatchServiceModule from '@/lib/services/componentPatchService';
import * as ComponentGeneratorModule from '@/lib/services/ComponentGenerator';
import { processJob } from '../worker';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-workercompregen-'));
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
  vi.restoreAllMocks();
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('processJob component regeneration call-site branching', () => {
  it('calls resolveComponentRegeneration when basedOnAssetId resolves to readable content', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'components', 'existing.html'), '<html><body><button data-gf-id="1">Buy</button></body></html>');
    const existingAsset = await assetService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'button', prompt: 'x',
      imagePath: 'existing.html', outputKind: 'component',
    });
    const job = await jobService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'button', prompt: 'make it blue',
      outputKind: 'component', options: { basedOnAssetId: existingAsset.id },
    });

    const resolveSpy = vi.spyOn(ComponentPatchServiceModule, 'resolveComponentRegeneration')
      .mockResolvedValue({ ok: true, filename: 'component-123-abcd1234.html' });

    await processJob(job);

    expect(resolveSpy).toHaveBeenCalledWith(expect.objectContaining({
      basedOnAssetId: existingAsset.id,
      instruction: 'make it blue',
      styleId: style.id,
    }));
    const updatedJob = await jobService.getById(job.id);
    expect(updatedJob?.status).toBe('complete');
    expect(updatedJob?.result_path).toBe('component-123-abcd1234.html');
  });

  it('falls back to the plain generate() call when basedOnAssetId is absent (first-generate, unchanged)', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const job = await jobService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'button', prompt: 'a button', outputKind: 'component',
    });

    const resolveSpy = vi.spyOn(ComponentPatchServiceModule, 'resolveComponentRegeneration');
    const generateSpy = vi.spyOn(ComponentGeneratorModule, 'getComponentGenerator').mockReturnValue({
      generate: vi.fn().mockResolvedValue({ path: 'result.html', prompt: 'a button' }),
      patchElement: vi.fn(),
    } as any);

    await processJob(job);

    expect(resolveSpy).not.toHaveBeenCalled();
    expect(generateSpy).toHaveBeenCalled();
  });

  it('falls back to the plain generate() call when basedOnAssetId is present but unreadable', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const job = await jobService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'button', prompt: 'a button',
      outputKind: 'component', options: { basedOnAssetId: 'not-a-real-asset-id' },
    });

    const resolveSpy = vi.spyOn(ComponentPatchServiceModule, 'resolveComponentRegeneration');
    const generateSpy = vi.spyOn(ComponentGeneratorModule, 'getComponentGenerator').mockReturnValue({
      generate: vi.fn().mockResolvedValue({ path: 'result.html', prompt: 'a button' }),
      patchElement: vi.fn(),
    } as any);

    await processJob(job);

    expect(resolveSpy).not.toHaveBeenCalled();
    expect(generateSpy).toHaveBeenCalled();
  });

  it('passes componentType through to resolveComponentRegeneration when the job options carry one', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'components', 'existing.html'), '<html><body><button data-gf-id="1">Buy</button></body></html>');
    const existingAsset = await assetService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'button', prompt: 'x',
      imagePath: 'existing.html', outputKind: 'component',
    });
    const job = await jobService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'button', prompt: 'make it blue',
      outputKind: 'component', options: { basedOnAssetId: existingAsset.id, componentType: 'Card' },
    });

    const resolveSpy = vi.spyOn(ComponentPatchServiceModule, 'resolveComponentRegeneration')
      .mockResolvedValue({ ok: true, filename: 'component-123-abcd1234.html' });

    await processJob(job);

    expect(resolveSpy).toHaveBeenCalledWith(expect.objectContaining({
      basedOnAssetId: existingAsset.id,
      instruction: 'make it blue',
      styleId: style.id,
      componentType: 'Card',
    }));
  });

  it('passes componentType through to the plain generate() call when the job options carry one (no basedOnAssetId)', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const job = await jobService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'button', prompt: 'a button',
      outputKind: 'component', options: { componentType: 'Button' },
    });

    const generateMock = vi.fn().mockResolvedValue({ path: 'result.html', prompt: 'a button' });
    vi.spyOn(ComponentGeneratorModule, 'getComponentGenerator').mockReturnValue({
      generate: generateMock,
      patchElement: vi.fn(),
    } as any);

    await processJob(job);

    // generate(prompt, styleId, componentType, referenceImage, basedOnContent, signal, providerOverride)
    expect(generateMock).toHaveBeenCalledWith('a button', style.id, 'Button', undefined, undefined, undefined, undefined);
  });

  it('passes componentType as undefined to generate() when absent from job options (backward compatibility, no crash)', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const job = await jobService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'button', prompt: 'a button', outputKind: 'component',
    });

    const generateMock = vi.fn().mockResolvedValue({ path: 'result.html', prompt: 'a button' });
    vi.spyOn(ComponentGeneratorModule, 'getComponentGenerator').mockReturnValue({
      generate: generateMock,
      patchElement: vi.fn(),
    } as any);

    await processJob(job);

    expect(generateMock).toHaveBeenCalledWith('a button', style.id, undefined, undefined, undefined, undefined, undefined);
    const updatedJob = await jobService.getById(job.id);
    expect(updatedJob?.status).toBe('complete');
  });

  it('marks the job failed when resolveComponentRegeneration returns ok:false', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'components', 'existing.html'), '<html><body><button data-gf-id="1">Buy</button></body></html>');
    const existingAsset = await assetService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'button', prompt: 'x',
      imagePath: 'existing.html', outputKind: 'component',
    });
    const job = await jobService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'button', prompt: 'make it blue',
      outputKind: 'component', options: { basedOnAssetId: existingAsset.id },
    });

    vi.spyOn(ComponentPatchServiceModule, 'resolveComponentRegeneration')
      .mockResolvedValue({ ok: false, message: 'Component changed while regenerating — please try again.' });

    await processJob(job);

    const updatedJob = await jobService.getById(job.id);
    expect(updatedJob?.status).toBe('failed');
    expect(updatedJob?.error_message).toBe('Component changed while regenerating — please try again.');
  });
});
