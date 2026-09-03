import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { processJob } from '@/worker';
import { MAX_PIECES_PER_SHEET } from '@/lib/utils/pieceShapes';

let tempRoot: string;
const STYLE_ID = '12121212-1212-1212-1212-121212121212';

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-workervalidation-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'gameforge-test' }));
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'images'), { recursive: true });

  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }

  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  const db = DatabaseConnection.getInstance();
  db.prepare(
    `INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at)
     VALUES (?, 'test style', 'user-1', '{}', 0, 1000, 1000)`
  ).run(STYLE_ID);
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

function insertJob(id: string, options: unknown) {
  const db = DatabaseConnection.getInstance();
  db.prepare(
    `INSERT INTO jobs (id, style_id, created_by, asset_type, prompt, status, result_path, created_at, updated_at, options)
     VALUES (?, ?, 'user-1', 'ui_sheet', 'a sheet', 'processing', NULL, 1000, 1000, ?)`
  ).run(id, STYLE_ID, JSON.stringify(options));
}

async function imagesWritten(): Promise<string[]> {
  const imagesDir = path.join(tempRoot, 'storage', 'images');
  return fsPromises.readdir(imagesDir).catch(() => []);
}

describe('worker.processJob() validates options.pieces server-side before calling the image generator', () => {
  it('marks the job failed, and never calls the generator, when pieces.length exceeds MAX_PIECES_PER_SHEET', async () => {
    const tooManyPieces = Array.from({ length: MAX_PIECES_PER_SHEET + 1 }, (_, i) => ({
      id: `p${i}`, kind: 'rounded_rect', label: `piece ${i}`, x: 0, y: 0, w: 10, h: 10,
    }));
    const jobId = '13131313-1313-1313-1313-131313131313';
    insertJob(jobId, { pieces: tooManyPieces, imageSize: { width: 256, height: 256 } });

    const db = DatabaseConnection.getInstance();
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    await processJob(job);

    const updated = db.prepare('SELECT status, result_path FROM jobs WHERE id = ?').get(jobId) as any;
    expect(updated.status).toBe('failed');
    expect(updated.result_path).toBeNull();

    // The MockGenerator writes a mock-sheet-*.png file when it's actually
    // invoked — confirms the Pixellab/generator call never happened, not
    // just that the job ended up failed for some unrelated reason.
    expect((await imagesWritten()).some(f => f.startsWith('mock-sheet-'))).toBe(false);
  });

  it('marks the job failed, and never calls the generator, when a piece is missing required fields', async () => {
    const jobId = '14141414-1414-1414-1414-141414141414';
    insertJob(jobId, {
      pieces: [{ id: 'a', kind: 'rounded_rect' /* missing label, x, y, w, h */ }],
      imageSize: { width: 256, height: 256 },
    });

    const db = DatabaseConnection.getInstance();
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    await processJob(job);

    const updated = db.prepare('SELECT status, result_path FROM jobs WHERE id = ?').get(jobId) as any;
    expect(updated.status).toBe('failed');
    expect(updated.result_path).toBeNull();
    expect((await imagesWritten()).some(f => f.startsWith('mock-sheet-'))).toBe(false);
  });

  it('still succeeds for a valid, in-bounds UI sheet job (the ordinary path is unaffected)', async () => {
    const jobId = '15151515-1515-1515-1515-151515151515';
    insertJob(jobId, {
      pieces: [{ id: 'a', kind: 'rounded_rect', label: 'Inventory', x: 0, y: 0, w: 10, h: 10 }],
      imageSize: { width: 256, height: 256 },
    });

    const db = DatabaseConnection.getInstance();
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    await processJob(job);

    const updated = db.prepare('SELECT status, result_path FROM jobs WHERE id = ?').get(jobId) as any;
    expect(updated.status).toBe('complete');
    expect(updated.result_path).not.toBeNull();
    expect((await imagesWritten()).some(f => f.startsWith('mock-sheet-'))).toBe(true);
  });
});
