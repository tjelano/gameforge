import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';

let tempRoot: string;
const STYLE_ID = '44444444-4444-4444-4444-444444444444';

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-workertheme-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'gameforge-test' }));

  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'themes'), { recursive: true });

  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  const db = DatabaseConnection.getInstance();
  db.prepare(
    `INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at)
     VALUES (?, 'style', 'user-1', '{}', 0, 1000, 1000)`
  ).run(STYLE_ID);
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('worker.ts routes theme jobs to ThemeGenerator', () => {
  it('a job with output_kind=\'theme\' completes via the mock theme generator, writing a .css result', async () => {
    const db = DatabaseConnection.getInstance();
    const jobId = 'job-theme-1';
    db.prepare(
      `INSERT INTO jobs (id, style_id, created_by, asset_type, prompt, status, result_path, created_at, updated_at, options, output_kind)
       VALUES (?, ?, 'user-1', 'theme', 'dark fantasy', 'pending', NULL, 1000, 1000, '{}', 'theme')`
    ).run(jobId, STYLE_ID);
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as any;

    const { processJob } = await import('@/worker');
    await processJob(job);

    const updated = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as any;
    expect(updated.status).toBe('complete');
    expect(updated.result_path).toMatch(/\.css$/);
  });

  it('a job with output_kind=\'image\' still routes to the existing pixel-art path', async () => {
    const db = DatabaseConnection.getInstance();
    const jobId = 'job-image-1';
    db.prepare(
      `INSERT INTO jobs (id, style_id, created_by, asset_type, prompt, status, result_path, created_at, updated_at, options, output_kind)
       VALUES (?, ?, 'user-1', 'sprite', 'a goblin', 'pending', NULL, 1000, 1000, '{}', 'image')`
    ).run(jobId, STYLE_ID);
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as any;

    const { processJob } = await import('@/worker');
    await processJob(job);

    const updated = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as any;
    expect(updated.status).toBe('complete');
    expect(updated.result_path).toMatch(/\.png$/);
  });

  it('a job with output_kind=\'component\' completes via the mock component generator, writing a .html result', async () => {
    const db = DatabaseConnection.getInstance();
    const jobId = 'job-component-1';
    db.prepare(
      `INSERT INTO jobs (id, style_id, created_by, asset_type, prompt, status, result_path, created_at, updated_at, options, output_kind)
       VALUES (?, ?, 'user-1', 'component', 'a button component', 'pending', NULL, 1000, 1000, '{}', 'component')`
    ).run(jobId, STYLE_ID);
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as any;

    const { processJob } = await import('@/worker');
    await processJob(job);

    const updated = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as any;
    expect(updated.status).toBe('complete');
    expect(updated.result_path).toMatch(/\.html$/);
  });

  it('a job with an unrecognized output_kind is marked failed, not silently processed as an image', async () => {
    const db = DatabaseConnection.getInstance();
    const jobId = 'job-bogus-1';
    db.prepare(
      `INSERT INTO jobs (id, style_id, created_by, asset_type, prompt, status, result_path, created_at, updated_at, options, output_kind)
       VALUES (?, ?, 'user-1', 'sprite', 'a goblin', 'pending', NULL, 1000, 1000, '{}', 'image')`
    ).run(jobId, STYLE_ID);
    // The jobs table has a CHECK(output_kind IN (...)) constraint (migration
    // 010), so a raw SQL UPDATE can't actually persist a corrupted value —
    // Zod validation is bypassed instead by overriding the field in memory
    // on the row object handed to processJob(), which only ever sees `job`
    // as `any` and has no runtime guarantee it went through Zod at all.
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as any;
    job.output_kind = 'bogus';

    const { processJob } = await import('@/worker');
    await processJob(job);

    const updated = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as any;
    expect(updated.status).toBe('failed');
    expect(updated.result_path).toBeNull();
  });

  it('passes a providerOverride to the theme generator when the job options request ollama', async () => {
    const generateSpy = vi.fn().mockResolvedValue({ path: 'theme-x.css', prompt: 'warm' });
    vi.spyOn(await import('@/lib/services/ThemeGenerator'), 'getThemeGenerator').mockReturnValue({ generate: generateSpy });

    const job = {
      id: 'job-1', style_id: 'style-1', prompt: 'warm', output_kind: 'theme',
      options: JSON.stringify({ provider: 'ollama', model: 'llama3-groq-tool-use:8b', ollamaHost: 'http://localhost:11434' }),
    };
    const { processJob } = await import('@/worker');
    await processJob(job as any);

    expect(generateSpy).toHaveBeenCalledWith('warm', 'style-1', undefined, undefined, undefined, {
      type: 'ollama', host: 'http://localhost:11434', model: 'llama3-groq-tool-use:8b',
    });
  });

  it('passes a providerOverride to the component generator when the job options request ollama', async () => {
    const generateSpy = vi.fn().mockResolvedValue({ path: 'component-x.html', prompt: 'a button' });
    vi.spyOn(await import('@/lib/services/ComponentGenerator'), 'getComponentGenerator').mockReturnValue({ generate: generateSpy, patchElement: vi.fn() });

    const job = {
      id: 'job-2', style_id: 'style-1', prompt: 'a button', output_kind: 'component',
      options: JSON.stringify({ provider: 'ollama', model: 'llama3-groq-tool-use:8b', ollamaHost: 'http://localhost:11434' }),
    };
    const { processJob } = await import('@/worker');
    await processJob(job as any);

    expect(generateSpy).toHaveBeenCalledWith('a button', 'style-1', undefined, undefined, undefined, undefined, {
      type: 'ollama', host: 'http://localhost:11434', model: 'llama3-groq-tool-use:8b',
    });
  });
});
