import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { DatabaseConnection } from '@/lib/database';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { getImageGenerator } from '@/lib/services/ImageGenerator';
import { getThemeGenerator } from '@/lib/services/ThemeGenerator';
import { getComponentGenerator } from '@/lib/services/ComponentGenerator';
import { WORKER_BATCH_SIZE } from '@/lib/config';
import { UiSheetOptionsSchema } from '@/lib/utils/pieceShapes';

const POLL_INTERVAL_MS = 2000;
const LOCK_FILE = path.join(getProjectRoot(), '.worker.lock');

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0: existence check only, doesn't actually kill
    return true;
  } catch {
    return false;
  }
}

function acquireLock(): void {
  if (fs.existsSync(LOCK_FILE)) {
    const pid = Number(fs.readFileSync(LOCK_FILE, 'utf-8').trim());
    if (pid && isProcessAlive(pid)) {
      console.error(`❌ Worker already running for this project (pid ${pid}). Exiting.`);
      process.exit(1);
    }
    console.warn(`⚠️ Stale worker lock file (pid ${pid} not running). Reclaiming.`);
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
}

function releaseLock(): void {
  try {
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
  } catch (e) {
    console.error('Failed to release worker lock:', e);
  }
}

export async function processJob(job: any): Promise<void> {
  const db = DatabaseConnection.getInstance();

  let options: any;
  try {
    options = JSON.parse(job.options);
  } catch (e) {
    // Malformed options JSON is a hard failure, not something to
    // silently ignore or default around — it means the row was
    // written by something that skipped the Zod contract.
    db.prepare(`UPDATE jobs SET status = 'failed', updated_at = ? WHERE id = ?`).run(Date.now(), job.id);
    console.error(`❌ Job ${job.id} has malformed options JSON:`, e);
    return;
  }

  const isUiSheet = Array.isArray(options.pieces) && options.pieces.length > 0;

  // A UI sheet spends a real, metered Pixellab call — validate the shape
  // and bound the piece count server-side before it gets that far. The
  // browser's MAX_PIECES_PER_SHEET cap and /api/generate's options
  // validation (z.record(...).unknown()) don't enforce this on their own.
  let sheetOptions: ReturnType<typeof UiSheetOptionsSchema.parse> | null = null;
  if (isUiSheet) {
    const parsed = UiSheetOptionsSchema.safeParse(options);
    if (!parsed.success) {
      db.prepare(`UPDATE jobs SET status = 'failed', updated_at = ? WHERE id = ?`).run(Date.now(), job.id);
      console.error(`❌ Job ${job.id} has invalid UI sheet options:`, parsed.error.message);
      return;
    }
    sheetOptions = parsed.data;
  }

  try {
    let result: { path: string };
    switch (job.output_kind) {
      case 'theme':
        result = await getThemeGenerator().generate(job.prompt, job.style_id);
        break;
      case 'component':
        result = await getComponentGenerator().generate(job.prompt, job.style_id);
        break;
      case 'image':
        result = sheetOptions
          ? await getImageGenerator().generateUiAsset(job.prompt, sheetOptions.pieces, sheetOptions.imageSize, sheetOptions.colorPalette)
          : await getImageGenerator().generate(job.prompt, job.style_id);
        break;
      default:
        // job.output_kind comes from a raw SQL row, not a Zod-validated
        // object — an unrecognized value must fail loudly, not silently
        // fall through to the image generator. Throwing here routes
        // through the existing catch below, which already marks the job
        // failed and logs — no separate failure-handling path needed.
        throw new Error(`Job ${job.id} has unrecognized output_kind: ${job.output_kind}`);
    }

    db.prepare(`UPDATE jobs SET status = 'complete', result_path = ?, updated_at = ? WHERE id = ?`)
      .run(result.path, Date.now(), job.id);
    console.log(`✅ Job ${job.id} complete -> ${result.path}`);
  } catch (error: any) {
    db.prepare(`UPDATE jobs SET status = 'failed', updated_at = ? WHERE id = ?`).run(Date.now(), job.id);
    console.error(`❌ Job ${job.id} failed:`, error.message);
  }
}

async function processJobs(): Promise<void> {
  const db = DatabaseConnection.getInstance();
  const claimed = db.prepare(`
    UPDATE jobs
    SET status = 'processing', updated_at = ?
    WHERE id IN (SELECT id FROM jobs WHERE status = 'pending' LIMIT ?)
    RETURNING *
  `).all(Date.now(), WORKER_BATCH_SIZE) as any[];

  if (claimed.length === 0) return;

  console.log(`⚙️  Claimed ${claimed.length} job(s).`);
  await Promise.allSettled(claimed.map((job) => processJob(job)));
}

function scheduleNext(): void {
  setTimeout(async () => {
    try {
      await processJobs();
    } catch (error) {
      console.error('❌ Worker tick failed:', error);
    } finally {
      scheduleNext();
    }
  }, POLL_INTERVAL_MS);
}

// Only run the actual worker loop (lock file, signal handlers, polling)
// when this file is the process entry point (`tsx worker.ts`) — not when
// a test imports processJob() to exercise it directly.
const isMainModule = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  acquireLock();
  process.on('exit', releaseLock);
  process.on('SIGINT', () => { releaseLock(); process.exit(0); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(0); });

  console.log(`🚀 GameForge worker started (pid ${process.pid}, batch size ${WORKER_BATCH_SIZE}).`);
  scheduleNext();
}
