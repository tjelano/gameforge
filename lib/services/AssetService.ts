import crypto from 'crypto';
import fsPromises from 'fs/promises';
import path from 'path';
import { DatabaseConnection } from '@/lib/database';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { IO_WRITE_BATCH_SIZE } from '@/lib/config';
import { AssetSchema, NineSliceMarginsSchema, type Asset, type AssetWithContrast, type NineSliceMargins } from '@/lib/database/schema';
import { sanitizeComponentCss } from '@/lib/services/componentSanitize';
import { parseThemeCss } from '@/lib/services/ThemeGenerator';
import { getContrastRatio, meetsWcagAA } from '@/lib/services/contrastChecker';

class AssetServiceImpl {
  async create(input: {
    styleId: string;
    createdBy: string;
    assetType: string;
    prompt: string;
    imagePath: string | null;
    sourceJobId?: string | null;
    outputKind?: 'image' | 'theme' | 'component';
  }): Promise<Asset> {
    const db = DatabaseConnection.getInstance();
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted, source_job_id, output_kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(id, input.styleId, input.createdBy, input.assetType, input.prompt, input.imagePath, Date.now(), input.sourceJobId ?? null, input.outputKind ?? 'image');
    return (await this.getById(id))!;
  }

  /** Only the creator, or an admin, may edit an asset. Mirrors StyleService.update(). */
  async update(id: string, requestingUserId: string, patch: {
    prompt?: string;
    assetType?: string;
    nineSliceMargins?: NineSliceMargins | null;
    states?: string[];
    editedExternally?: boolean;
  }, isAdmin: boolean = false): Promise<Asset | { error: 'NOT_FOUND' | 'FORBIDDEN' }> {
    const existing = await this.getById(id);
    if (!existing) return { error: 'NOT_FOUND' };
    if (existing.created_by !== requestingUserId && !isAdmin) return { error: 'FORBIDDEN' };
    const db = DatabaseConnection.getInstance();

    const nineSliceMargins = patch.nineSliceMargins !== undefined
      ? (patch.nineSliceMargins === null ? null : JSON.stringify(NineSliceMarginsSchema.parse(patch.nineSliceMargins)))
      : existing.nine_slice_margins;
    const states = patch.states !== undefined ? JSON.stringify(patch.states) : existing.states;
    const editedExternally = patch.editedExternally !== undefined ? (patch.editedExternally ? 1 : 0) : existing.edited_externally;

    db.prepare('UPDATE assets SET prompt = ?, asset_type = ?, nine_slice_margins = ?, states = ?, edited_externally = ? WHERE id = ?').run(
      patch.prompt ?? existing.prompt,
      patch.assetType ?? existing.asset_type,
      nineSliceMargins,
      states,
      editedExternally,
      id
    );
    return (await this.getById(id))!;
  }
  /** All non-deleted assets, newest first. */
  async getActiveAssets(): Promise<Asset[]> {
    const db = DatabaseConnection.getInstance();
    const rows = db.prepare('SELECT * FROM assets WHERE is_deleted = 0 ORDER BY created_at DESC').all();
    return rows.map(row => AssetSchema.parse(row));
  }

  /** Active theme assets for one style — used for dedup comparison, scoped to that style's own aesthetic. */
  async getActiveThemeAssetsForStyle(styleId: string): Promise<Asset[]> {
    const db = DatabaseConnection.getInstance();
    const rows = db.prepare(
      `SELECT * FROM assets WHERE style_id = ? AND output_kind = 'theme' AND is_deleted = 0 ORDER BY created_at DESC`
    ).all(styleId);
    return rows.map(row => AssetSchema.parse(row));
  }

  /**
   * A style's most-recently-promoted theme's CSS, re-sanitized through the
   * same boundary component CSS goes through. Theme CSS is validated by a
   * completely separate pipeline (ThemeTokensSchema) at generation/edit
   * time only, never re-checked at serve time the way component files now
   * are - reusing sanitizeComponentCss here closes that gap. Returns null
   * (no theme available) for any reason the theme can't be used: no
   * styleId, no promoted theme, unreadable file, or failed sanitization.
   * Shared by the component-serve route and the page-render route.
   */
  async loadThemeCssForStyle(styleId: string | null): Promise<string | null> {
    if (!styleId) return null;
    try {
      const themes = await this.getActiveThemeAssetsForStyle(styleId);
      if (themes.length === 0) return null;
      const themeFilename = themes[0].image_path;
      if (!themeFilename || themeFilename.includes('/') || themeFilename.includes('\\') || themeFilename.includes('..')) {
        return null;
      }
      const themePath = path.join(getProjectRoot(), 'storage', 'themes', themeFilename);
      const rawCss = await fsPromises.readFile(themePath, 'utf-8');
      return sanitizeComponentCss(rawCss);
    } catch (e) {
      console.error(`Could not load theme CSS for style ${styleId}:`, e);
      return null;
    }
  }

  /** All active assets (any kind) for one style — powers the Style Bible Hub page. */
  async getActiveAssetsForStyle(styleId: string): Promise<Asset[]> {
    const db = DatabaseConnection.getInstance();
    const rows = db.prepare(
      `SELECT * FROM assets WHERE style_id = ? AND is_deleted = 0 ORDER BY created_at DESC`
    ).all(styleId);
    return rows.map(row => AssetSchema.parse(row));
  }

  /** Every asset row, active and soft-deleted alike. Used for Git export. */
  async getAll(): Promise<Asset[]> {
    const db = DatabaseConnection.getInstance();
    const rows = db.prepare('SELECT * FROM assets ORDER BY created_at DESC').all();
    return rows.map(row => AssetSchema.parse(row));
  }

  async getById(id: string): Promise<Asset | null> {
    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
    return row ? AssetSchema.parse(row) : null;
  }

  async getByImagePath(imagePath: string): Promise<Asset | null> {
    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT * FROM assets WHERE image_path = ?').get(imagePath);
    return row ? AssetSchema.parse(row) : null;
  }

  async getPage(limit: number, offset: number): Promise<Asset[]> {
    const db = DatabaseConnection.getInstance();
    const rows = db.prepare(
      'SELECT * FROM assets WHERE is_deleted = 0 ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).all(limit, offset);
    return rows.map(row => AssetSchema.parse(row));
  }

  /**
   * Reads and parses a theme asset's CSS file. Shared by the single-asset contrast route
   * (`/api/assets/[id]/contrast`) and `withContrastData` below, so the two never drift on how a
   * theme file is located/parsed. Throws on any failure -- callers decide how to surface that
   * (the route maps it to a specific status code; withContrastData treats it as contrast: null
   * for just that one asset).
   */
  async readThemeTokens(assetId: string, imagePath: string) {
    let css: string;
    try {
      css = await fsPromises.readFile(path.join(getProjectRoot(), 'storage', 'themes', imagePath), 'utf-8');
    } catch (e) {
      console.error(`Failed to read theme file for contrast check (asset ${assetId}):`, e);
      throw e;
    }
    try {
      return parseThemeCss(css);
    } catch (e) {
      console.error(`Failed to parse theme CSS for contrast check (asset ${assetId}):`, e);
      throw e;
    }
  }

  /**
   * Attaches each theme asset's contrast ratio in one pass, computed from its already-loaded
   * row data -- for a LIST of assets. Do not fetch this per-asset over the network from a list
   * page (that was the original bug: N assets meant N separate HTTP round trips, each queued
   * behind the browser's per-origin connection limit, compounding into multi-second page loads
   * as the asset count grew). A single-asset page fetching its own contrast via
   * `/api/assets/[id]/contrast` is fine -- that's one request, not N.
   */
  async withContrastData(assets: Asset[]): Promise<AssetWithContrast[]> {
    return Promise.all(assets.map(async asset => {
      if (
        asset.output_kind !== 'theme' || !asset.image_path ||
        asset.image_path.includes('/') || asset.image_path.includes('\\') || asset.image_path.includes('..')
      ) {
        return { ...asset, contrast: null };
      }
      try {
        const tokens = await this.readThemeTokens(asset.id, asset.image_path);
        const ratio = getContrastRatio(tokens.colorBackground, tokens.colorForeground);
        return { ...asset, contrast: { ratio, meetsAA: meetsWcagAA(ratio) } };
      } catch (e) {
        console.error(`Failed to compute contrast for asset ${asset.id}:`, e);
        return { ...asset, contrast: null };
      }
    }));
  }

  /** Only the creator, or an admin, may delete an asset. Mirrors update() above. */
  async softDelete(id: string, requestingUserId: string, isAdmin: boolean = false): Promise<void | { error: 'NOT_FOUND' | 'FORBIDDEN' }> {
    const existing = await this.getById(id);
    if (!existing) return { error: 'NOT_FOUND' };
    if (existing.created_by !== requestingUserId && !isAdmin) return { error: 'FORBIDDEN' };
    const db = DatabaseConnection.getInstance();
    db.prepare('UPDATE assets SET is_deleted = 1 WHERE id = ?').run(id);
  }

  /**
   * Removes physical files in storage/<subdir>/ that are no longer needed.
   * Shared by cleanupOrphanedImages() and cleanupOrphanedThemes() — the
   * protection rule below must stay identical for both, so change it
   * here, not in either public wrapper.
   *
   * A file is PROTECTED (never deleted) if it is referenced by:
   *  - any asset row, active OR soft-deleted — soft-deleted assets must
   *    stay recoverable, file included, until permanently pruned by
   *    some future explicit "empty trash" action (not this function).
   *  - any job with status IN ('pending', 'processing', 'complete') —
   *    i.e. anything the user hasn't yet promoted or discarded. A
   *    'complete' job the user simply hasn't looked at yet is not
   *    orphaned; it's awaiting a decision.
   *
   * Everything else in storage/<subdir>/ is deleted. Returns the count
   * of files actually removed. Not filtered by output_kind — a theme
   * filename never appears in an image row's image_path or vice versa,
   * so the two storage directories never share filenames.
   */
  private async cleanupOrphanedIn(subdir: 'images' | 'themes' | 'components'): Promise<number> {
    const db = DatabaseConnection.getInstance();
    const dir = path.join(getProjectRoot(), 'storage', subdir);

    let filenames: string[];
    try {
      filenames = (await fsPromises.readdir(dir, { withFileTypes: true }))
        .filter(entry => entry.isFile() && entry.name !== '.gitkeep')
        .map(entry => entry.name);
    } catch (e) {
      console.error(`Failed to read storage/${subdir} for cleanup:`, e);
      return 0;
    }

    const assetPaths = new Set(
      (db.prepare('SELECT image_path FROM assets WHERE image_path IS NOT NULL').all() as { image_path: string }[])
        .map(row => row.image_path)
    );

    const activeJobPaths = new Set(
      (db.prepare(`
        SELECT result_path FROM jobs
        WHERE result_path IS NOT NULL
        AND status IN ('pending', 'processing', 'complete')
      `).all() as { result_path: string }[])
        .map(row => row.result_path)
    );

    const orphans = filenames.filter(f => !assetPaths.has(f) && !activeJobPaths.has(f));

    let removed = 0;
    for (let i = 0; i < orphans.length; i += IO_WRITE_BATCH_SIZE) {
      const chunk = orphans.slice(i, i + IO_WRITE_BATCH_SIZE);
      const results = await Promise.all(chunk.map(async (filename) => {
        const filePath = path.join(dir, filename);
        try {
          await fsPromises.unlink(filePath);
          return true;
        } catch (e: any) {
          if (e.code !== 'ENOENT') console.error(`Failed to remove orphaned file ${filename}:`, e);
          return false;
        }
      }));
      removed += results.filter(Boolean).length;
    }

    return removed;
  }

  /** Removes physical files in storage/images/ that are no longer needed. See cleanupOrphanedIn(). */
  async cleanupOrphanedImages(): Promise<number> {
    return this.cleanupOrphanedIn('images');
  }

  /** Removes physical files in storage/themes/ that are no longer needed. See cleanupOrphanedIn(). */
  async cleanupOrphanedThemes(): Promise<number> {
    return this.cleanupOrphanedIn('themes');
  }

  /** Removes physical files in storage/components/ that are no longer needed. See cleanupOrphanedIn(). */
  async cleanupOrphanedComponents(): Promise<number> {
    return this.cleanupOrphanedIn('components');
  }

  /**
   * Removes physical files in storage/references/ that are no longer
   * needed. Unlike cleanupOrphanedIn() (which protects via jobs.result_path,
   * the GENERATED-output column), a reference image's filename lives inside
   * jobs.options — it's an INPUT the user supplied, not a job's result — so
   * this needs its own protected-paths query reading that JSON field.
   */
  async cleanupOrphanedReferences(): Promise<number> {
    const db = DatabaseConnection.getInstance();
    const dir = path.join(getProjectRoot(), 'storage', 'references');

    let filenames: string[];
    try {
      filenames = (await fsPromises.readdir(dir, { withFileTypes: true }))
        .filter(entry => entry.isFile() && entry.name !== '.gitkeep')
        .map(entry => entry.name);
    } catch (e) {
      console.error('Failed to read storage/references for cleanup:', e);
      return 0;
    }

    const activeReferencePaths = new Set(
      (db.prepare(`
        SELECT json_extract(options, '$.referenceImageFilename') AS filename FROM jobs
        WHERE json_valid(options)
        AND json_type(options, '$.referenceImageFilename') = 'text'
        AND status IN ('pending', 'processing', 'complete')
      `).all() as { filename: string }[])
        .map(row => row.filename)
    );

    const orphans = filenames.filter(f => !activeReferencePaths.has(f));

    let removed = 0;
    for (let i = 0; i < orphans.length; i += IO_WRITE_BATCH_SIZE) {
      const chunk = orphans.slice(i, i + IO_WRITE_BATCH_SIZE);
      const results = await Promise.all(chunk.map(async (filename) => {
        const filePath = path.join(dir, filename);
        try {
          await fsPromises.unlink(filePath);
          return true;
        } catch (e: any) {
          if (e.code !== 'ENOENT') console.error(`Failed to remove orphaned reference image ${filename}:`, e);
          return false;
        }
      }));
      removed += results.filter(Boolean).length;
    }

    return removed;
  }
}

export const assetService = new AssetServiceImpl();
