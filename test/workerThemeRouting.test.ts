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
});
