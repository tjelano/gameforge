import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { seedSession } from './helpers/testSession';
import { styleService } from '@/lib/services/StyleService';
import { jobService } from '@/lib/services/JobService';
import { saveReferenceImage } from '@/lib/services/referenceImage';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-workergrounding-'));
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
  vi.doUnmock('@/lib/services/inspoGrounding');
  vi.doUnmock('@/lib/services/ComponentGenerator');
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('worker.ts grounding integration', () => {
  it('does not call groundComponent when a user-supplied referenceImageFilename is present', async () => {
    const groundComponentMock = vi.fn();
    vi.doMock('@/lib/services/inspoGrounding', () => ({ groundComponent: groundComponentMock }));
    vi.doMock('@/lib/services/ComponentGenerator', () => ({
      getComponentGenerator: () => ({ generate: vi.fn().mockResolvedValue({ path: 'out.html' }) }),
    }));
    vi.resetModules();
    const { processJob } = await import('@/worker');

    const { userId } = await seedSession();
    const style = await styleService.create({ name: 'X', createdBy: userId, parameters: '{"colorAccent":"#3b82f6"}' });
    await styleService.update(style.id, userId, { groundWithInspo: true });
    // A real file on disk, not just a filename string in options -- loadReferenceImage()
    // reads it back off disk and returns null (defense-in-depth) for a filename that
    // doesn't actually resolve to a file, so worker.ts's `!referenceImage` gate needs
    // a genuine saved reference image to correctly observe "user supplied one."
    const filename = await saveReferenceImage({ base64: 'ZmFrZQ==', mediaType: 'image/png' });
    const job = await jobService.create({
      styleId: style.id, assetType: 'component', prompt: 'A button', outputKind: 'component',
      options: { componentType: 'Button', groundWithInspo: true, referenceImageFilename: filename },
      createdBy: userId,
    });

    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id);
    await processJob(row);

    expect(groundComponentMock).not.toHaveBeenCalled();
  });

  it('calls groundComponent and records grounded:true on the job options on success', async () => {
    vi.doMock('@/lib/services/inspoGrounding', () => ({
      groundComponent: vi.fn().mockResolvedValue({
        grounded: true, referenceImage: { base64: 'AAAA', mediaType: 'image/png' },
        referenceIsFallbackThumbnail: false, colorMatched: true,
      }),
    }));
    vi.doMock('@/lib/services/ComponentGenerator', () => ({
      getComponentGenerator: () => ({ generate: vi.fn().mockResolvedValue({ path: 'out.html' }) }),
    }));
    vi.resetModules();
    const { processJob } = await import('@/worker');

    const { userId } = await seedSession();
    const style = await styleService.create({ name: 'X', createdBy: userId, parameters: '{"colorAccent":"#3b82f6"}' });
    await styleService.update(style.id, userId, { groundWithInspo: true });
    const job = await jobService.create({
      styleId: style.id, assetType: 'component', prompt: 'A button', outputKind: 'component',
      options: { componentType: 'Button', groundWithInspo: true },
      createdBy: userId,
    });

    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id);
    await processJob(row);

    const updated = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id) as any;
    const options = JSON.parse(updated.options);
    expect(options.grounded).toBe(true);
    expect(options.colorMatched).toBe(true);
  });

  it('records grounded:false and still completes the job when grounding finds no match', async () => {
    vi.doMock('@/lib/services/inspoGrounding', () => ({
      groundComponent: vi.fn().mockResolvedValue({ grounded: false, groundedReason: 'no-match' }),
    }));
    vi.doMock('@/lib/services/ComponentGenerator', () => ({
      getComponentGenerator: () => ({ generate: vi.fn().mockResolvedValue({ path: 'out.html' }) }),
    }));
    vi.resetModules();
    const { processJob } = await import('@/worker');

    const { userId } = await seedSession();
    const style = await styleService.create({ name: 'X', createdBy: userId, parameters: '{"colorAccent":"#3b82f6"}' });
    await styleService.update(style.id, userId, { groundWithInspo: true });
    const job = await jobService.create({
      styleId: style.id, assetType: 'component', prompt: 'A button', outputKind: 'component',
      options: { componentType: 'Button', groundWithInspo: true },
      createdBy: userId,
    });

    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id);
    await processJob(row);

    const updated = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id) as any;
    expect(updated.status).toBe('complete');
    const options = JSON.parse(updated.options);
    expect(options.grounded).toBe(false);
    expect(options.groundedReason).toBe('no-match');
  });

  it('does not call groundComponent when the style has not opted in', async () => {
    const groundComponentMock = vi.fn();
    vi.doMock('@/lib/services/inspoGrounding', () => ({ groundComponent: groundComponentMock }));
    vi.doMock('@/lib/services/ComponentGenerator', () => ({
      getComponentGenerator: () => ({ generate: vi.fn().mockResolvedValue({ path: 'out.html' }) }),
    }));
    vi.resetModules();
    const { processJob } = await import('@/worker');

    const { userId } = await seedSession();
    const style = await styleService.create({ name: 'X', createdBy: userId, parameters: '{"colorAccent":"#3b82f6"}' });
    const job = await jobService.create({
      styleId: style.id, assetType: 'component', prompt: 'A button', outputKind: 'component',
      options: { componentType: 'Button', groundWithInspo: false },
      createdBy: userId,
    });

    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id);
    await processJob(row);

    expect(groundComponentMock).not.toHaveBeenCalled();
  });

  it('does not call groundComponent for a job with an absent/unrecognized componentType (backward compat)', async () => {
    const groundComponentMock = vi.fn();
    vi.doMock('@/lib/services/inspoGrounding', () => ({ groundComponent: groundComponentMock }));
    vi.doMock('@/lib/services/ComponentGenerator', () => ({
      getComponentGenerator: () => ({ generate: vi.fn().mockResolvedValue({ path: 'out.html' }) }),
    }));
    vi.resetModules();
    const { processJob } = await import('@/worker');

    const { userId } = await seedSession();
    const style = await styleService.create({ name: 'X', createdBy: userId, parameters: '{"colorAccent":"#3b82f6"}' });
    await styleService.update(style.id, userId, { groundWithInspo: true });
    // No componentType in options at all -- simulates a job queued before this field existed.
    const job = await jobService.create({
      styleId: style.id, assetType: 'component', prompt: 'A button', outputKind: 'component',
      options: { groundWithInspo: true },
      createdBy: userId,
    });

    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id);
    await processJob(row);

    expect(groundComponentMock).not.toHaveBeenCalled();
  });
});
