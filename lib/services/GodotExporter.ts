import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { assetService } from '@/lib/services/AssetService';
import { styleService } from '@/lib/services/StyleService';

export interface ExportResult {
  exported: number;
  skipped: number;
  targetDir: string;
}

class GodotExporterImpl {
  /**
   * Copies one Style Bible's active assets' physical images into
   * storage/exports/{subdir}/ (2D only for V1 — filenames only, the
   * exporter is responsible for the physical path, per the
   * "database stores filenames, not URLs" hard rule).
   *
   * The target directory is claimed with a single atomic (non-recursive)
   * mkdir, mirroring SiteExporter.exportSite()'s own collision guard: it
   * either creates targetDir and this call owns it, or fails with EEXIST
   * because some earlier export (any style, any time) already used this
   * subdir name. Unlike SiteExporter there's no manifest here to check
   * "is this a safe re-export of the same style" against — a Godot export
   * is a flat image copy with no hand-edit-preservation concept to
   * protect, so a reused subdir is simply rejected outright.
   */
  async exportToGodot(styleId: string, subdir: string): Promise<ExportResult | { error: 'ALREADY_EXISTS' | 'STYLE_NOT_FOUND' }> {
    if (!(await styleService.getActiveById(styleId))) {
      return { error: 'STYLE_NOT_FOUND' };
    }

    const imagesDir = path.join(getProjectRoot(), 'storage', 'images');
    const exportsRootDir = path.join(getProjectRoot(), 'storage', 'exports');
    const targetDir = path.join(exportsRootDir, subdir);

    try {
      await fsPromises.mkdir(exportsRootDir, { recursive: true });
    } catch (e) {
      console.error(`Failed to create the exports root directory ${exportsRootDir}:`, e);
      throw e;
    }

    try {
      await fsPromises.mkdir(targetDir);
    } catch (e: any) {
      if (e?.code !== 'EEXIST') {
        console.error(`Failed to create export target directory ${targetDir}:`, e);
        throw e;
      }
      return { error: 'ALREADY_EXISTS' };
    }

    const assets = (await assetService.getActiveAssetsForStyle(styleId)).filter(asset => asset.output_kind === 'image');

    let exported = 0;
    let skipped = 0;

    for (const asset of assets) {
      if (!asset.image_path) {
        skipped++;
        continue;
      }
      const sourcePath = path.join(imagesDir, asset.image_path);
      const destPath = path.join(targetDir, asset.image_path);
      try {
        await fsPromises.copyFile(sourcePath, destPath);
        exported++;
      } catch (e) {
        console.error(`Failed to export asset image ${asset.image_path}:`, e);
        skipped++;
      }
    }

    return { exported, skipped, targetDir };
  }
}

export const godotExporter = new GodotExporterImpl();
