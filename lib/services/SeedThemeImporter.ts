import crypto from 'crypto';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { styleService } from '@/lib/services/StyleService';
import { assetService } from '@/lib/services/AssetService';
import { tokensToCss } from '@/lib/services/ThemeGenerator';
import { fetchDaisyUiThemes } from '@/lib/services/seedThemes/daisyUiMapper';
import { fetchBootswatchThemes } from '@/lib/services/seedThemes/bootswatchMapper';
import type { SeedTheme } from '@/lib/services/seedThemes/types';

const SEED_CREATED_BY = 'system-seed';

export interface SeedImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

async function createSeedTheme(styleName: string, theme: SeedTheme): Promise<void> {
  const style = await styleService.create({
    name: styleName,
    createdBy: SEED_CREATED_BY,
    parameters: JSON.stringify(theme.tokens),
  });

  const filename = `seed-${crypto.randomUUID()}.css`;
  const themesDir = path.join(getProjectRoot(), 'storage', 'themes');
  try {
    await fsPromises.mkdir(themesDir, { recursive: true });
    await fsPromises.writeFile(path.join(themesDir, filename), tokensToCss(theme.tokens));
  } catch (e) {
    console.error(`Failed to write seed theme file ${filename}:`, e);
    throw e;
  }

  await assetService.create({
    styleId: style.id,
    createdBy: SEED_CREATED_BY,
    assetType: 'theme',
    prompt: `Seeded from ${styleName}`,
    imagePath: filename,
    outputKind: 'theme',
  });
}

async function importFromSource(
  attributionPrefix: string,
  fetchThemes: () => Promise<SeedTheme[]>,
  existingNames: Set<string>,
  errors: string[]
): Promise<{ imported: number; skipped: number }> {
  let themes: SeedTheme[];
  try {
    themes = await fetchThemes();
  } catch (e: any) {
    errors.push(`${attributionPrefix}: ${e.message}`);
    return { imported: 0, skipped: 0 };
  }

  let imported = 0;
  let skipped = 0;
  for (const theme of themes) {
    const styleName = `${attributionPrefix}: ${theme.name}`;
    if (existingNames.has(styleName)) {
      skipped++;
      continue;
    }
    try {
      await createSeedTheme(styleName, theme);
    } catch (e: any) {
      errors.push(`${attributionPrefix}: ${theme.name}: ${e.message}`);
      continue;
    }
    existingNames.add(styleName);
    imported++;
  }
  return { imported, skipped };
}

export async function importSeedThemes(): Promise<SeedImportResult> {
  const existingStyles = await styleService.getAll();
  const existingNames = new Set(existingStyles.map(s => s.name));
  const errors: string[] = [];

  const daisyResult = await importFromSource('DaisyUI', fetchDaisyUiThemes, existingNames, errors);
  const bootswatchResult = await importFromSource('Bootswatch', fetchBootswatchThemes, existingNames, errors);

  return {
    imported: daisyResult.imported + bootswatchResult.imported,
    skipped: daisyResult.skipped + bootswatchResult.skipped,
    errors,
  };
}
