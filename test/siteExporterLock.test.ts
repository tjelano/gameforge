import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { pageService } from '@/lib/services/PageService';
import { assetService } from '@/lib/services/AssetService';
import { siteExporter } from '@/lib/services/SiteExporter';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-siteexportlock-'));
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'components'), { recursive: true });
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
  vi.useRealTimers();
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

const COMPONENT_DOC = '<!DOCTYPE html><html><head><style>.btn { color: red; }</style></head><body><button class="btn">Go</button></body></html>';

async function setUpStyleWithOnePage(subdir: string) {
  const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
  await fsPromises.writeFile(path.join(tempRoot, 'storage', 'components', 'comp.html'), COMPONENT_DOC);
  await assetService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'button', prompt: 'a button', imagePath: 'comp.html', outputKind: 'component' });
  await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
  return style;
}

describe('siteExporter.exportSite concurrency', () => {
  it('refuses a second concurrent export of the same (styleId, subdir) while the first is in flight', async () => {
    const style = await setUpStyleWithOnePage('my-site');

    // Hold the lock directory open manually to simulate an in-flight export,
    // rather than racing two real exportSite() calls (too fast to reliably
    // interleave in a single-threaded test).
    const lockDir = path.join(tempRoot, 'storage', 'exports', '.locks', 'my-site.lock');
    await fsPromises.mkdir(lockDir, { recursive: true });
    await fsPromises.writeFile(path.join(lockDir, 'heartbeat'), String(Date.now()));

    const result = await siteExporter.exportSite(style.id, 'my-site');
    expect(result).toHaveProperty('error');
    if (!('error' in result)) throw new Error('expected an error result');
    expect(result.error).toBe('EXPORT_IN_PROGRESS');
  });

  it('recovers a stale lock (heartbeat older than the staleness window) and proceeds', async () => {
    const style = await setUpStyleWithOnePage('my-site');

    const lockDir = path.join(tempRoot, 'storage', 'exports', '.locks', 'my-site.lock');
    await fsPromises.mkdir(lockDir, { recursive: true });
    const staleTimestamp = Date.now() - 10 * 60 * 1000; // 10 minutes ago - well past the 2-minute staleness window
    await fsPromises.writeFile(path.join(lockDir, 'heartbeat'), String(staleTimestamp));

    const result = await siteExporter.exportSite(style.id, 'my-site');
    expect('error' in result).toBe(false);
  });

  it('does not treat an in-progress export as stale just because it is slow', async () => {
    const style = await setUpStyleWithOnePage('my-site');

    const lockDir = path.join(tempRoot, 'storage', 'exports', '.locks', 'my-site.lock');
    await fsPromises.mkdir(lockDir, { recursive: true });
    const recentTimestamp = Date.now() - 30 * 1000; // 30 seconds ago - well within the 2-minute window
    await fsPromises.writeFile(path.join(lockDir, 'heartbeat'), String(recentTimestamp));

    const result = await siteExporter.exportSite(style.id, 'my-site');
    expect(result).toHaveProperty('error');
    if (!('error' in result)) throw new Error('expected an error result');
    expect(result.error).toBe('EXPORT_IN_PROGRESS');
  });

  it('lets two concurrent exports race a stale-lock recovery without corrupting the target directory', async () => {
    // Design-doc-called-for scenario: two contenders both observe the SAME
    // pre-seeded stale lock and both attempt recovery at once. The atomic
    // rename in tryRecoverStaleLock means only one contender's rename can
    // succeed - but depending on exact timing, the loser may either get
    // EXPORT_IN_PROGRESS (the winner still holds a fresh lock when the loser
    // checks) or itself succeed (the winner fully exported and released
    // before the loser ever attempted tryClaim/isLockStale). Either outcome
    // is fine - what must NEVER happen is both writers touching targetDir at
    // the same time and leaving a corrupted/partial manifest behind.
    const style = await setUpStyleWithOnePage('my-site');

    const lockDir = path.join(tempRoot, 'storage', 'exports', '.locks', 'my-site.lock');
    await fsPromises.mkdir(lockDir, { recursive: true });
    const staleTimestamp = Date.now() - 10 * 60 * 1000; // 10 minutes ago - well past the 2-minute staleness window
    await fsPromises.writeFile(path.join(lockDir, 'heartbeat'), String(staleTimestamp));

    const [a, b] = await Promise.all([
      siteExporter.exportSite(style.id, 'my-site'),
      siteExporter.exportSite(style.id, 'my-site'),
    ]);
    const results = [a, b];
    const successes = results.filter(r => !('error' in r));
    const inProgress = results.filter(r => 'error' in r && r.error === 'EXPORT_IN_PROGRESS');

    // The stale lock must be recoverable by at least one of the two -
    // never zero (that would mean the recovery race itself deadlocked both
    // contenders), and every non-success result must be EXPORT_IN_PROGRESS,
    // never some other error (which would indicate the two writers actually
    // collided on disk instead of one cleanly losing the race).
    expect(successes.length).toBeGreaterThanOrEqual(1);
    expect(successes.length + inProgress.length).toBe(2);

    const manifestRaw = await fsPromises.readFile(
      path.join(tempRoot, 'storage', 'exports', 'my-site', 'gameforge-manifest.json'),
      'utf-8'
    );
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.styleId).toBe(style.id);
    expect(manifest.pages).toHaveLength(1);
  });
});
