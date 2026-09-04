import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { assetService } from '@/lib/services/AssetService';

export interface ExportResult {
  exported: number;
  skipped: number;
  targetDir: string;
}

class GodotExporterImpl {
  /**
   * Copies every active asset's physical image into
   * storage/exports/{subdir}/ (2D only for V1 — filenames only, the
   * exporter is responsible for the physical path, per the
   * "database stores filenames, not URLs" hard rule).
   */
  async exportToGodot(subdir: string): Promise<ExportResult> {
    const imagesDir = path.join(getProjectRoot(), 'storage', 'images');
    const targetDir = path.join(getProjectRoot(), 'storage', 'exports', subdir);
    await fsPromises.mkdir(targetDir, { recursive: true });

    const assets = (await assetService.getActiveAssets()).filter(asset => asset.output_kind === 'image');

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
