import simpleGit from 'simple-git';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { assetService } from '@/lib/services/AssetService';
import { styleService } from '@/lib/services/StyleService';
import { userService } from '@/lib/services/UserService';
import { presetService } from '@/lib/services/PresetService';
import { pageService } from '@/lib/services/PageService';
import { storageDirFor } from '@/lib/services/shared/assetSafety';
import { hashContent } from '@/lib/services/ExportManifest';
import { IO_WRITE_BATCH_SIZE } from '@/lib/config';
import { StyleSchema, AssetSchema, UserSchema, PresetSchema, PageSchema } from '@/lib/database/schema';

export interface SyncResult {
  success: boolean;
  error?: string;
  message?: string;
}

// Line-anchored: a real git conflict marker owns its whole line.
const CONFLICT_MARKER_REGEX = /^<<<<<<<|^=======$|^>>>>>>>/m;

const DATA_DIRS = ['data/styles', 'data/assets', 'data/users', 'data/presets', 'data/pages'] as const;

class GitServiceImpl {
  private git() {
    return simpleGit(getProjectRoot());
  }

  private async ensureDirectoriesExist(): Promise<void> {
    for (const dir of DATA_DIRS) {
      await fsPromises.mkdir(path.join(getProjectRoot(), dir), { recursive: true });
    }
    await fsPromises.mkdir(path.join(getProjectRoot(), 'storage', 'images'), { recursive: true });
    await fsPromises.mkdir(path.join(getProjectRoot(), 'storage', 'themes'), { recursive: true });
    await fsPromises.mkdir(path.join(getProjectRoot(), 'storage', 'components'), { recursive: true });
  }

  async exportToJson(): Promise<void> {
    await this.ensureDirectoriesExist();

    const styles = await styleService.getAll();
    const assets = await assetService.getAll();
    const users = await userService.getAll();
    const presets = await presetService.getAll();
    const pages = await pageService.getAll();

    const stylesDir = path.join(getProjectRoot(), 'data', 'styles');
    const assetsDir = path.join(getProjectRoot(), 'data', 'assets');
    const usersDir = path.join(getProjectRoot(), 'data', 'users');
    const presetsDir = path.join(getProjectRoot(), 'data', 'presets');
    const pagesDir = path.join(getProjectRoot(), 'data', 'pages');

    for (const style of styles) {
      const filePath = path.join(stylesDir, `style-${style.id}.json`);
      await fsPromises.writeFile(filePath, JSON.stringify(style, null, 2), 'utf-8');
    }

    for (const asset of assets) {
      const filePath = path.join(assetsDir, `asset-${asset.id}.json`);
      await fsPromises.writeFile(filePath, JSON.stringify(asset, null, 2), 'utf-8');
    }

    for (const user of users) {
      const filePath = path.join(usersDir, `user-${user.id}.json`);
      await fsPromises.writeFile(filePath, JSON.stringify(user, null, 2), 'utf-8');
    }

    for (const preset of presets) {
      const filePath = path.join(presetsDir, `preset-${preset.id}.json`);
      await fsPromises.writeFile(filePath, JSON.stringify(preset, null, 2), 'utf-8');
    }

    for (const page of pages) {
      const filePath = path.join(pagesDir, `page-${page.id}.json`);
      await fsPromises.writeFile(filePath, JSON.stringify(page, null, 2), 'utf-8');
    }
  }

  async importFromJson(): Promise<void> {
    const db = DatabaseConnection.getInstance();

    const usersDir = path.join(getProjectRoot(), 'data', 'users');
    const userFiles = await this.readJsonFiles(usersDir);
    for (const { filePath, content } of userFiles) {
      if (CONFLICT_MARKER_REGEX.test(content)) {
        throw new Error(`Conflict markers found in ${filePath}. Please resolve manually.`);
      }
      const data = UserSchema.parse(JSON.parse(content));
      db.prepare(`
        INSERT INTO users (id, name, is_admin, created_at)
        VALUES (@id, @name, @is_admin, @created_at)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          is_admin = excluded.is_admin,
          created_at = excluded.created_at
      `).run(data);
    }

    const stylesDir = path.join(getProjectRoot(), 'data', 'styles');
    const styleFiles = await this.readJsonFiles(stylesDir);
    for (const { filePath, content } of styleFiles) {
      if (CONFLICT_MARKER_REGEX.test(content)) {
        throw new Error(`Conflict markers found in ${filePath}. Please resolve manually.`);
      }
      const data = StyleSchema.parse(JSON.parse(content));
      db.prepare(`
        INSERT INTO styles (id, name, created_by, parameters, forked_from, is_deleted, created_at, updated_at)
        VALUES (@id, @name, @created_by, @parameters, @forked_from, @is_deleted, @created_at, @updated_at)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          created_by = excluded.created_by,
          parameters = excluded.parameters,
          forked_from = excluded.forked_from,
          is_deleted = excluded.is_deleted,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `).run(data);
    }

    const assetsDir = path.join(getProjectRoot(), 'data', 'assets');
    const assetFiles = await this.readJsonFiles(assetsDir);
    for (const { filePath, content } of assetFiles) {
      if (CONFLICT_MARKER_REGEX.test(content)) {
        throw new Error(`Conflict markers found in ${filePath}. Please resolve manually.`);
      }
      const data = AssetSchema.parse(JSON.parse(content));
      // source_job_id is deliberately NOT imported: it's machine-local
      // provenance pointing at a jobs row, and jobs are never git-synced
      // (DATA_DIRS above). Writing it here would FK-fail on any machine
      // that doesn't happen to have that job locally, aborting the whole
      // import. nine_slice_margins/states are portable and still synced.
      // edited_externally is deliberately never imported either (forced to 0
      // below): trusting a component enough to serve it unsanitized is a
      // machine-local decision, made only via PATCH /api/assets/[id]/component
      // and never via sync, so a git pull can't grant that trust to content
      // nobody on this machine reviewed.
      db.prepare(`
        INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted, nine_slice_margins, states, output_kind, edited_externally)
        VALUES (@id, @style_id, @created_by, @asset_type, @prompt, @image_path, @created_at, @is_deleted, @nine_slice_margins, @states, @output_kind, 0)
        ON CONFLICT(id) DO UPDATE SET
          style_id = excluded.style_id,
          created_by = excluded.created_by,
          asset_type = excluded.asset_type,
          prompt = excluded.prompt,
          image_path = excluded.image_path,
          created_at = excluded.created_at,
          is_deleted = excluded.is_deleted,
          nine_slice_margins = excluded.nine_slice_margins,
          states = excluded.states,
          output_kind = excluded.output_kind,
          edited_externally = 0
      `).run(data);
    }

    const presetsDir = path.join(getProjectRoot(), 'data', 'presets');
    const presetFiles = await this.readJsonFiles(presetsDir);
    for (const { filePath, content } of presetFiles) {
      if (CONFLICT_MARKER_REGEX.test(content)) {
        throw new Error(`Conflict markers found in ${filePath}. Please resolve manually.`);
      }
      const data = PresetSchema.parse(JSON.parse(content));
      db.prepare(`
        INSERT INTO presets (id, name, created_by, prompt, tech_stack_tags, theme_prompt, components, is_deleted, created_at, updated_at)
        VALUES (@id, @name, @created_by, @prompt, @tech_stack_tags, @theme_prompt, @components, @is_deleted, @created_at, @updated_at)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          created_by = excluded.created_by,
          prompt = excluded.prompt,
          tech_stack_tags = excluded.tech_stack_tags,
          theme_prompt = excluded.theme_prompt,
          components = excluded.components,
          is_deleted = excluded.is_deleted,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `).run(data);
    }

    // Pages import LAST - pages.style_id is a real FK (REFERENCES styles(id)),
    // so styles must already exist in the DB before this runs.
    const pagesDir = path.join(getProjectRoot(), 'data', 'pages');
    const pageFiles = await this.readJsonFiles(pagesDir);
    for (const { filePath, content } of pageFiles) {
      if (CONFLICT_MARKER_REGEX.test(content)) {
        throw new Error(`Conflict markers found in ${filePath}. Please resolve manually.`);
      }
      const data = PageSchema.parse(JSON.parse(content));
      db.prepare(`
        INSERT INTO pages (id, style_id, name, created_by, component_asset_ids, is_deleted, created_at, updated_at)
        VALUES (@id, @style_id, @name, @created_by, @component_asset_ids, @is_deleted, @created_at, @updated_at)
        ON CONFLICT(id) DO UPDATE SET
          style_id = excluded.style_id,
          name = excluded.name,
          created_by = excluded.created_by,
          component_asset_ids = excluded.component_asset_ids,
          is_deleted = excluded.is_deleted,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `).run(data);
    }
  }

  private async readJsonFiles(dir: string): Promise<{ filePath: string; content: string }[]> {
    let entries: fs.Dirent[];
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const files = entries.filter(entry => entry.isFile() && entry.name.endsWith('.json'));
    const results: { filePath: string; content: string }[] = [];
    for (const entry of files) {
      const filePath = path.join(dir, entry.name);
      const content = await fsPromises.readFile(filePath, 'utf-8');
      results.push({ filePath, content });
    }
    return results;
  }

  private async stageFilesForCommit(): Promise<void> {
    const git = this.git();
    await git.add('data/');

    const activeAssets = await assetService.getActiveAssets();
    const validPaths: string[] = [];

    for (let i = 0; i < activeAssets.length; i += IO_WRITE_BATCH_SIZE) {
      const chunk = activeAssets.slice(i, i + IO_WRITE_BATCH_SIZE);
      const existenceChecks = chunk.map(async (asset) => {
        if (!asset.image_path) return null;
        const subdir = storageDirFor(asset.output_kind);
        const physicalPath = path.join(getProjectRoot(), 'storage', subdir, asset.image_path);
        try {
          await fsPromises.access(physicalPath, fs.constants.F_OK);
          return `storage/${subdir}/${asset.image_path}`;
        } catch {
          return null;
        }
      });
      const results = await Promise.all(existenceChecks);
      validPaths.push(...results.filter((r): r is string => r !== null));
    }

    for (let i = 0; i < validPaths.length; i += IO_WRITE_BATCH_SIZE) {
      const chunk = validPaths.slice(i, i + IO_WRITE_BATCH_SIZE);
      await git.add(chunk);
    }

    const gitattributesPath = path.join(getProjectRoot(), '.gitattributes');
    if (fs.existsSync(gitattributesPath)) {
      await git.add('.gitattributes');
    }
  }

  /**
   * importFromJson() force-resets edited_externally to 0 on every asset it
   * imports, which closes a real hole: a hostile git history could otherwise
   * ship a malicious component file plus an asset row claiming it was
   * hand-reviewed, and every puller would then serve it unsanitized. The side
   * effect is that a routine pull()/resolveConflicts() also strips trust from
   * THIS machine's own untouched components. These two helpers put it back —
   * but only when the component file's bytes prove nothing actually changed:
   * snapshot the hashes while the working tree is still purely local, re-check
   * after the import, restore only on an exact match. A file the pull genuinely
   * changed hashes differently and correctly stays untrusted until re-reviewed.
   *
   * `skipPaths` (repo-relative, forward slashes) excludes files git already
   * reports as changed — needed by resolveConflicts(), where the merge has
   * already been applied to the working tree before we get a look at it.
   */
  private async snapshotTrustedComponentHashes(skipPaths?: Set<string>): Promise<Map<string, string>> {
    const db = DatabaseConnection.getInstance();
    const trustedRows = db.prepare(
      `SELECT id, image_path FROM assets WHERE edited_externally = 1 AND output_kind = 'component' AND image_path IS NOT NULL`
    ).all() as { id: string; image_path: string }[];

    const preHashes = new Map<string, string>();
    for (const row of trustedRows) {
      if (skipPaths?.has(`storage/components/${row.image_path}`)) continue;
      try {
        const content = await fsPromises.readFile(path.join(getProjectRoot(), 'storage', 'components', row.image_path), 'utf-8');
        preHashes.set(row.id, hashContent(content));
      } catch (e: any) {
        // A missing file is expected here (cleanup removed it, or it was never
        // written): there's nothing to compare after the import, so
        // importFromJson()'s force-to-0 stands, which is the safe fallback.
        if (e.code !== 'ENOENT') console.error(`Failed to hash trusted component ${row.image_path} before import:`, e);
      }
    }
    return preHashes;
  }

  private async restoreTrustForUnchangedComponents(preHashes: Map<string, string>): Promise<void> {
    for (const [assetId, preHash] of preHashes) {
      const asset = await assetService.getById(assetId);
      if (!asset || asset.is_deleted || asset.output_kind !== 'component' || !asset.image_path) continue;
      try {
        const content = await fsPromises.readFile(path.join(getProjectRoot(), 'storage', 'components', asset.image_path), 'utf-8');
        if (hashContent(content) === preHash) {
          await assetService.update(assetId, { editedExternally: true });
        }
      } catch (e: any) {
        if (e.code !== 'ENOENT') console.error(`Failed to re-check trusted component ${asset.image_path} after import:`, e);
      }
    }
  }

  private async assertNoConflictMarkers(): Promise<void> {
    for (const dir of DATA_DIRS) {
      const dirPath = path.join(getProjectRoot(), dir);
      const files = await this.readJsonFiles(dirPath);
      for (const { filePath, content } of files) {
        if (CONFLICT_MARKER_REGEX.test(content)) {
          throw new Error(
            `Unresolved conflict markers found in ${filePath}. Please resolve manually before committing.`
          );
        }
      }
    }
  }

  async pull(): Promise<SyncResult> {
    await this.ensureDirectoriesExist();
    await this.exportToJson();

    const removedImages = await assetService.cleanupOrphanedImages();
    const removedThemes = await assetService.cleanupOrphanedThemes();
    const removedComponents = await assetService.cleanupOrphanedComponents();
    const removedReferences = await assetService.cleanupOrphanedReferences();
    if (removedImages > 0 || removedThemes > 0 || removedComponents > 0 || removedReferences > 0) {
      console.log(`🧹 Removed ${removedImages} orphaned images, ${removedThemes} orphaned themes, ${removedComponents} orphaned components, and ${removedReferences} orphaned reference images.`);
    }

    const git = this.git();
    const status = await git.status();
    if (status.files && status.files.length > 0) {
      await this.stageFilesForCommit();
      try {
        await git.commit('Local changes (pre-pull save)');
      } catch (e: any) {
        if (!e.message.includes('nothing to commit')) throw e;
      }
    }

    // Snapshot BEFORE git.pull(): afterwards, a component file the remote
    // changed already holds the incoming bytes on disk, so a later snapshot
    // would compare that content against itself and restore trust for exactly
    // the content that needs re-review.
    const trustedComponentHashes = await this.snapshotTrustedComponentHashes();

    await git.pull(['--no-rebase']);

    try {
      await this.importFromJson();
    } finally {
      await this.restoreTrustForUnchangedComponents(trustedComponentHashes);
    }
    return { success: true };
  }

  async push(): Promise<SyncResult> {
    try {
      const styles = await styleService.getAll();
      const assets = await assetService.getAll();
      if (styles.length === 0 && assets.length === 0) {
        return {
          success: false,
          error: 'SAFETY_STOP',
          message: '⚠️ Safety stop: You have no styles or assets.',
        };
      }

      await this.exportToJson();

      const removedImages = await assetService.cleanupOrphanedImages();
      const removedThemes = await assetService.cleanupOrphanedThemes();
      const removedComponents = await assetService.cleanupOrphanedComponents();
      const removedReferences = await assetService.cleanupOrphanedReferences();
      if (removedImages > 0 || removedThemes > 0 || removedComponents > 0 || removedReferences > 0) {
        console.log(`🧹 Removed ${removedImages} orphaned images, ${removedThemes} orphaned themes, ${removedComponents} orphaned components, and ${removedReferences} orphaned reference images.`);
      }

      await this.stageFilesForCommit();

      const git = this.git();
      const status = await git.status();
      if (status.files && status.files.length > 0) {
        try {
          await git.commit('Sync from GameForge');
        } catch (e: any) {
          if (!e.message.includes('nothing to commit')) throw e;
        }
      }

      let isUnborn = false;
      try {
        await git.raw(['rev-parse', '--is-inside-work-tree']);
        const headExists = await git.raw(['rev-parse', 'HEAD']).then(() => true).catch(() => false);
        isUnborn = !headExists;
      } catch (error: any) {
        return { success: false, error: 'GIT_ERROR', message: error.message };
      }

      const branches = await git.branch();
      const currentBranch = branches.current;

      if (isUnborn) {
        await git.push(['--set-upstream', 'origin', currentBranch, '--atomic']);
      } else {
        const upstream = await git.raw(['rev-parse', '--abbrev-ref', `${currentBranch}@{upstream}`]).catch(() => null);
        if (!upstream) {
          await git.push(['--set-upstream', 'origin', currentBranch, '--atomic']);
        } else {
          await git.push(['--atomic']);
        }
      }

      return { success: true };
    } catch (error: any) {
      return { success: false, error: 'PUSH_FAILED', message: error.message };
    }
  }

  async abortMerge(): Promise<SyncResult> {
    try {
      await this.git().merge(['--abort']);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: 'ABORT_FAILED', message: error.message };
    }
  }

  /**
   * Resolves an in-progress merge conflict. Refuses to stage or commit
   * anything if leftover conflict markers are still present in any
   * data/styles or data/assets JSON file — validation happens BEFORE
   * staging, not just as a post-commit detection pass.
   */
  async resolveConflicts(): Promise<void> {
    await this.assertNoConflictMarkers();

    const git = this.git();

    // The merge is already applied to the working tree by the time this runs,
    // so on-disk content is no longer purely local. Anything git reports as
    // changed — a staged merge result, an unmerged conflict, or the user's own
    // hand-resolution — is excluded from trust preservation, so only files the
    // merge provably left alone can keep it. Untracked files are not excluded:
    // git refuses to clobber them during a merge, so they are still local.
    const mergeTouched = new Set(
      (await git.status()).files
        .filter(f => !(f.index === '?' && f.working_dir === '?'))
        .map(f => f.path)
    );
    const trustedComponentHashes = await this.snapshotTrustedComponentHashes(mergeTouched);

    await this.stageFilesForCommit();

    try {
      await git.commit('Resolved merge conflicts');
    } catch (e: any) {
      if (!e.message.includes('nothing to commit')) throw e;
    }

    // Defense-in-depth only: assertNoConflictMarkers() already validated
    // file contents above, so importFromJson() failing here means a
    // genuine DB-level problem, not a marker slipping through.
    try {
      await this.importFromJson();
      await this.restoreTrustForUnchangedComponents(trustedComponentHashes);
    } catch (importError) {
      await git.reset(['--merge', 'ORIG_HEAD']);
      throw new Error('Merge completed but database sync failed. Rolled back.');
    }
  }
}

export const gitService = new GitServiceImpl();
