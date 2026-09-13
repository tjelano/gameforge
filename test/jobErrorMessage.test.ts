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
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-joberrormsg-'));
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

describe("a thrown generator error is persisted as the job's error_message", () => {
  it("stores the error's message and marks the job failed", async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const job = await jobService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'sprite', prompt: 'a goblin', outputKind: 'image',
    });

    vi.spyOn(ImageGeneratorModule, 'getImageGenerator').mockReturnValue({
      generate: vi.fn().mockRejectedValue(new Error('Pixellab generation failed (500): server exploded')),
      generateUiAsset: vi.fn(),
    } as any);

    await processJob(job);

    const db = DatabaseConnection.getInstance();
    const updated = db.prepare('SELECT status, error_message FROM jobs WHERE id = ?').get(job.id) as any;
    expect(updated.status).toBe('failed');
    expect(updated.error_message).toBe('Pixellab generation failed (500): server exploded');
  });
});
