import simpleGit from 'simple-git';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { assetService } from '@/lib/services/AssetService';
import { styleService } from '@/lib/services/StyleService';
import { userService } from '@/lib/services/UserService';
import { storageDirFor } from '@/lib/services/shared/assetSafety';
import { IO_WRITE_BATCH_SIZE } from '@/lib/config';
import { StyleSchema, AssetSchema, UserSchema } from '@/lib/database/schema';

export interface SyncResult {
  success: boolean;
  error?: string;
  message?: string;
}

// Line-anchored: a real git conflict marker owns its whole line.
const CONFLICT_MARKER_REGEX = /^<<<<<<<|^=======$|^>>>>>>>/m;

const DATA_DIRS = ['data/styles', 'data/assets', 'data/users'] as const;

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

    const stylesDir = path.join(getProjectRoot(), 'data', 'styles');
    const assetsDir = path.join(getProjectRoot(), 'data', 'assets');
    const usersDir = path.join(getProjectRoot(), 'data', 'users');

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
      db.prepare(`
        INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted, nine_slice_margins, states, output_kind)
        VALUES (@id, @style_id, @created_by, @asset_type, @prompt, @image_path, @created_at, @is_deleted, @nine_slice_margins, @states, @output_kind)
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
          output_kind = excluded.output_kind
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
    if (removedImages > 0 || removedThemes > 0 || removedComponents > 0) {
      console.log(`🧹 Removed ${removedImages} orphaned images, ${removedThemes} orphaned themes, and ${removedComponents} orphaned components.`);
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

    await git.pull(['--no-rebase']);

    await this.importFromJson();
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
      if (removedImages > 0 || removedThemes > 0 || removedComponents > 0) {
        console.log(`🧹 Removed ${removedImages} orphaned images, ${removedThemes} orphaned themes, and ${removedComponents} orphaned components.`);
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

    await this.stageFilesForCommit();

    const git = this.git();
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
    } catch (importError) {
      await git.reset(['--merge', 'ORIG_HEAD']);
      throw new Error('Merge completed but database sync failed. Rolled back.');
    }
  }
}

export const gitService = new GitServiceImpl();
