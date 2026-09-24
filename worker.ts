import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';
import { DatabaseConnection } from '@/lib/database';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { getImageGenerator } from '@/lib/services/ImageGenerator';
import { getThemeGenerator } from '@/lib/services/ThemeGenerator';
import { getComponentGenerator } from '@/lib/services/ComponentGenerator';
import { resolveComponentRegeneration } from '@/lib/services/componentPatchService';
import { assetService } from '@/lib/services/AssetService';
import { loadReferenceImage, mediaTypeForFilename } from '@/lib/services/referenceImage';
import { groundComponent } from '@/lib/services/inspoGrounding';
import { styleService } from '@/lib/services/StyleService';
import { settingsService } from '@/lib/services/SettingsService';
import { WORKER_BATCH_SIZE, WORKER_LAST_SEEN_SETTING_KEY, POLL_INTERVAL_MS } from '@/lib/config';
import { UiSheetOptionsSchema } from '@/lib/utils/pieceShapes';
import type { ProviderOverride } from '@/lib/services/providerOverride';

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

/**
 * Resolves options.basedOnAssetId to that asset's current stored content
 * (theme CSS or component HTML), for the regenerate-with-feedback flow.
 * Returns undefined (never throws) if the id is missing, the asset can't be
 * found, its output_kind isn't theme/component, or its file can't be read —
 * this is best-effort context, same reasoning as ClaudeApiThemeGenerator's
 * own dedup-steering loop not failing the whole job over one bad read.
 */
async function loadBasedOnContent(basedOnAssetId: unknown, jobId: string): Promise<string | undefined> {
  if (typeof basedOnAssetId !== 'string') return undefined;
  try {
    const asset = await assetService.getById(basedOnAssetId);
    if (!asset?.image_path) return undefined;
    if (asset.image_path.includes('/') || asset.image_path.includes('\\') || asset.image_path.includes('..')) return undefined;
    const subdir = asset.output_kind === 'theme' ? 'themes' : asset.output_kind === 'component' ? 'components' : null;
    if (!subdir) return undefined;
    return await fsPromises.readFile(path.join(getProjectRoot(), 'storage', subdir, asset.image_path), 'utf-8');
  } catch (e) {
    console.error(`Job ${jobId}: failed to load basedOnAssetId ${basedOnAssetId} content, continuing without it:`, e);
    return undefined;
  }
}

/**
 * For a sprite regeneration: when the user didn't attach a fresh reference
 * image, fall back to the based-on asset's own stored image so the
 * "regenerate with changes" flow still has a real visual connection to what
 * it's regenerating from. Never throws - a missing/invalid asset or a read
 * failure just means no fallback reference, same best-effort reasoning as
 * loadBasedOnContent().
 */
async function loadSpriteBasedOnImage(basedOnAssetId: unknown, jobId: string): Promise<import('@/lib/services/referenceImage').ReferenceImagePayload | undefined> {
  if (typeof basedOnAssetId !== 'string') return undefined;
  try {
    const asset = await assetService.getById(basedOnAssetId);
    if (!asset?.image_path || asset.output_kind !== 'image') return undefined;
    if (asset.image_path.includes('/') || asset.image_path.includes('\\') || asset.image_path.includes('..')) return undefined;
    const mediaType = mediaTypeForFilename(asset.image_path);
    if (!mediaType) return undefined;
    const buffer = await fsPromises.readFile(path.join(getProjectRoot(), 'storage', 'images', asset.image_path));
    return { base64: buffer.toString('base64'), mediaType };
  } catch (e) {
    console.error(`Job ${jobId}: failed to load basedOnAssetId ${basedOnAssetId}'s own image for sprite regeneration, continuing without it:`, e);
    return undefined;
  }
}

/**
 * Builds the providerOverride the Task-2 generators expect, from a job's
 * raw options object. Returns undefined for a Claude job (the default) --
 * only 'ollama'/'openrouter' jobs ever set this. `correctionRequested` is
 * omitted entirely rather than set to `false` when absent -- it's an
 * optional field on both override variants, and omitting it (instead of
 * always including an explicit `false`) keeps the object's shape identical
 * to what a plain job (no correction) already produces.
 *
 * `options.ollamaCorrectionRequested` is read for the openrouter branch too
 * (not renamed) since it's currently unreachable there anyway:
 * app/api/jobs/retry-with-correction/route.ts -- the only place that sets
 * this flag -- gates the whole retry feature on the job's error_message
 * starting with OLLAMA_NO_TOOL_CALL_ERROR_PREFIX, which callOpenRouterTool()
 * never throws. If that route is ever extended to cover OpenRouter's own
 * hard-fail errors, give it its own option key at that point rather than
 * reusing this Ollama-named one.
 */
function buildProviderOverride(options: any): ProviderOverride | undefined {
  if (options.provider === 'ollama') {
    const override: ProviderOverride = { type: 'ollama', host: options.ollamaHost, model: options.model };
    if (options.ollamaCorrectionRequested === true) override.correctionRequested = true;
    return override;
  }
  if (options.provider === 'openrouter') {
    const override: ProviderOverride = { type: 'openrouter', model: options.model };
    if (options.ollamaCorrectionRequested === true) override.correctionRequested = true;
    return override;
  }
  return undefined;
}

function markJobFailed(db: ReturnType<typeof DatabaseConnection.getInstance>, jobId: string, errorMessage: string): void {
  db.prepare(`UPDATE jobs SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?`).run(errorMessage, Date.now(), jobId);
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
    markJobFailed(db, job.id, e instanceof Error ? e.message : String(e));
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
      markJobFailed(db, job.id, parsed.error.message);
      console.error(`❌ Job ${job.id} has invalid UI sheet options:`, parsed.error.message);
      return;
    }
    sheetOptions = parsed.data;
  }

  const referenceImage = await loadReferenceImage(
    typeof options.referenceImageFilename === 'string' ? options.referenceImageFilename : undefined
  );
  const referenceStrength = typeof options.referenceStrength === 'number' ? options.referenceStrength : undefined;
  const width = typeof options.width === 'number' ? options.width : undefined;
  const height = typeof options.height === 'number' ? options.height : undefined;
  const componentType = typeof options.componentType === 'string' ? options.componentType : undefined;

  let groundingResult: { grounded: boolean; groundedReason?: string; referenceIsFallbackThumbnail?: boolean; colorMatched?: boolean } | undefined;
  let groundedReferenceImage: { base64: string; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' } | undefined;

  const shouldAttemptGrounding =
    job.output_kind === 'component' &&
    options.groundWithInspo === true &&
    !referenceImage &&
    typeof componentType === 'string';

  if (shouldAttemptGrounding) {
    try {
      const style = await styleService.getById(job.style_id);
      const colorAccent = style ? (JSON.parse(style.parameters || '{}').colorAccent as string | undefined) : undefined;
      if (colorAccent) {
        const outcome = await groundComponent({ styleId: job.style_id, componentType: componentType!, colorAccent });
        if (outcome.grounded) {
          groundedReferenceImage = outcome.referenceImage;
          groundingResult = { grounded: true, referenceIsFallbackThumbnail: outcome.referenceIsFallbackThumbnail, colorMatched: outcome.colorMatched };
        } else {
          groundingResult = { grounded: false, groundedReason: outcome.groundedReason };
        }
      } else {
        groundingResult = { grounded: false, groundedReason: 'no-accent-color' };
      }
    } catch (error) {
      console.error(`Grounding pre-check failed for job ${job.id}:`, error);
      groundingResult = { grounded: false, groundedReason: 'error' };
    }
  }

  const effectiveReferenceImage = referenceImage ?? groundedReferenceImage ?? null;

  try {
    let result: { path: string };
    switch (job.output_kind) {
      case 'theme': {
        const basedOnContent = await loadBasedOnContent(options.basedOnAssetId, job.id);
        const providerOverride = buildProviderOverride(options);
        result = await getThemeGenerator().generate(job.prompt, job.style_id, referenceImage ?? undefined, basedOnContent, undefined, providerOverride);
        break;
      }
      case 'component': {
        const basedOnContent = await loadBasedOnContent(options.basedOnAssetId, job.id);
        const providerOverride = buildProviderOverride(options);
        if (basedOnContent !== undefined && typeof options.basedOnAssetId === 'string') {
          const resolved = await resolveComponentRegeneration({
            basedOnAssetId: options.basedOnAssetId,
            basedOnContent,
            instruction: job.prompt,
            styleId: job.style_id,
            componentType,
            referenceImage: effectiveReferenceImage ?? undefined,
            providerOverride,
          });
          if (!resolved.ok) throw new Error(resolved.message);
          result = { path: resolved.filename };
        } else {
          result = await getComponentGenerator().generate(job.prompt, job.style_id, componentType, effectiveReferenceImage ?? undefined, basedOnContent, undefined, providerOverride) as { path: string };
        }
        break;
      }
      case 'image': {
        // No AbortController is constructed here — every generator (Theme,
        // Component, PageLayout, Pixellab/Image) now accepts an optional
        // signal (see Tasks 18-19), but nothing in this app has a cancel-job
        // feature to produce one yet. Wiring one up is out of scope until
        // a cancel-job feature is actually requested.
        const spriteReferenceImage = referenceImage ?? (await loadSpriteBasedOnImage(options.basedOnAssetId, job.id));
        result = sheetOptions
          ? await getImageGenerator().generateUiAsset(job.prompt, sheetOptions.pieces, sheetOptions.imageSize, sheetOptions.colorPalette)
          : await getImageGenerator().generate(job.prompt, job.style_id, { referenceImage: spriteReferenceImage, referenceStrength, width, height });
        break;
      }
      default:
        // job.output_kind comes from a raw SQL row, not a Zod-validated
        // object — an unrecognized value must fail loudly, not silently
        // fall through to the image generator. Throwing here routes
        // through the existing catch below, which already marks the job
        // failed and logs — no separate failure-handling path needed.
        throw new Error(`Job ${job.id} has unrecognized output_kind: ${job.output_kind}`);
    }

    const finalOptions = groundingResult ? JSON.stringify({ ...options, ...groundingResult }) : job.options;
    db.prepare(`UPDATE jobs SET status = 'complete', result_path = ?, options = ?, updated_at = ? WHERE id = ?`)
      .run(result.path, finalOptions, Date.now(), job.id);
    console.log(`✅ Job ${job.id} complete -> ${result.path}`);
  } catch (error: any) {
    markJobFailed(db, job.id, error instanceof Error ? error.message : String(error));
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

// Independent of scheduleNext/processJobs on purpose -- see the heartbeat
// note above Task 6's worker.ts changes in the plan this came from: a
// heartbeat gated behind a slow job's completion would falsely read "dead"
// while the worker is busy with real, long-running work.
function writeHeartbeat(): void {
  settingsService.set(WORKER_LAST_SEEN_SETTING_KEY, String(Date.now())).catch(error => {
    console.error('❌ Worker heartbeat write failed:', error);
  });
}

function startHeartbeat(): void {
  writeHeartbeat();
  setInterval(writeHeartbeat, POLL_INTERVAL_MS);
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
  startHeartbeat();
  scheduleNext();
}
