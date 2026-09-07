import crypto from 'crypto';
import { DatabaseConnection } from '@/lib/database';
import { PresetSchema, type Preset, type PresetComponent } from '@/lib/database/schema';
import { styleService } from '@/lib/services/StyleService';

class PresetServiceImpl {
  async getActivePresets(): Promise<Preset[]> {
    const db = DatabaseConnection.getInstance();
    const rows = db.prepare('SELECT * FROM presets WHERE is_deleted = 0 ORDER BY created_at DESC').all();
    return rows.map(row => PresetSchema.parse(row));
  }

  async getById(id: string): Promise<Preset | null> {
    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT * FROM presets WHERE id = ?').get(id);
    return row ? PresetSchema.parse(row) : null;
  }

  async create(input: {
    name: string;
    createdBy: string;
    prompt: string;
    techStackTags: string;
    themePrompt: string | null;
    components: string;
  }): Promise<Preset> {
    const db = DatabaseConnection.getInstance();
    const id = crypto.randomUUID();
    const now = Date.now();
    db.prepare(`
      INSERT INTO presets (id, name, created_by, prompt, tech_stack_tags, theme_prompt, components, is_deleted, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(id, input.name, input.createdBy, input.prompt, input.techStackTags, input.themePrompt, input.components, now, now);
    return (await this.getById(id))!;
  }

  /** No ownership check - presets are shared, any logged-in user may edit any preset. */
  async update(id: string, patch: {
    name?: string;
    prompt?: string;
    techStackTags?: string;
    themePrompt?: string | null;
    components?: string;
  }): Promise<Preset | null> {
    const existing = await this.getById(id);
    if (!existing) return null;
    const db = DatabaseConnection.getInstance();
    db.prepare(`
      UPDATE presets SET name = ?, prompt = ?, tech_stack_tags = ?, theme_prompt = ?, components = ?, updated_at = ? WHERE id = ?
    `).run(
      patch.name ?? existing.name,
      patch.prompt ?? existing.prompt,
      patch.techStackTags ?? existing.tech_stack_tags,
      patch.themePrompt !== undefined ? patch.themePrompt : existing.theme_prompt,
      patch.components ?? existing.components,
      Date.now(),
      id
    );
    return this.getById(id);
  }

  async softDelete(id: string): Promise<void> {
    const db = DatabaseConnection.getInstance();
    db.prepare('UPDATE presets SET is_deleted = 1, updated_at = ? WHERE id = ?').run(Date.now(), id);
  }

  /**
   * Creates a Style Bible (if newStyleName given) plus one job per preset
   * item (the theme, if set, then every component), all sharing one
   * batch_id — atomically, inside a single db.transaction(). A mid-loop
   * failure (e.g. malformed components JSON on a corrupted row) rolls back
   * the whole operation rather than leaving a half-populated new style,
   * unlike the lower-stakes multi-candidate loop in app/api/generate/route.ts
   * which has no such transaction.
   *
   * The "nothing to generate" case is a plain return of the error value
   * from inside the transaction callback (not a thrown custom Error
   * subclass — AGENTS.md forbids those). It happens before any write, so
   * committing that empty transaction is a no-op.
   */
  async applyPreset(
    presetId: string,
    target: { newStyleName?: string; existingStyleId?: string },
    createdBy: string
  ): Promise<
    | { styleId: string; batchId: string; jobIds: string[] }
    | { error: 'PRESET_NOT_FOUND' | 'STYLE_NOT_FOUND' | 'NOTHING_TO_GENERATE' }
  > {
    const preset = await this.getById(presetId);
    if (!preset) return { error: 'PRESET_NOT_FOUND' };

    if (target.existingStyleId) {
      const existing = await styleService.getById(target.existingStyleId);
      if (!existing) return { error: 'STYLE_NOT_FOUND' };
    }

    const db = DatabaseConnection.getInstance();

    const runApply = db.transaction(():
      | { styleId: string; batchId: string; jobIds: string[] }
      | { error: 'NOTHING_TO_GENERATE' } => {
      const components = JSON.parse(preset.components) as PresetComponent[];
      if (!preset.theme_prompt && components.length === 0) {
        return { error: 'NOTHING_TO_GENERATE' };
      }

      let styleId: string;
      if (target.existingStyleId) {
        styleId = target.existingStyleId;
      } else {
        styleId = crypto.randomUUID();
        const now = Date.now();
        db.prepare(`
          INSERT INTO styles (id, name, created_by, parameters, forked_from, is_deleted, created_at, updated_at)
          VALUES (?, ?, ?, '{}', NULL, 0, ?, ?)
        `).run(styleId, target.newStyleName, createdBy, now, now);
      }

      const items: { assetType: string; prompt: string; outputKind: 'theme' | 'component' }[] = [];
      if (preset.theme_prompt) {
        items.push({ assetType: 'theme', prompt: preset.theme_prompt, outputKind: 'theme' });
      }
      for (const c of components) {
        items.push({ assetType: c.assetType, prompt: c.prompt, outputKind: 'component' });
      }

      const batchId = crypto.randomUUID();
      const jobIds: string[] = [];
      for (const item of items) {
        const jobId = crypto.randomUUID();
        const now = Date.now();
        db.prepare(`
          INSERT INTO jobs (id, style_id, created_by, asset_type, prompt, status, result_path, created_at, updated_at, options, output_kind, batch_id)
          VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?, '{}', ?, ?)
        `).run(jobId, styleId, createdBy, item.assetType, item.prompt, now, now, item.outputKind, batchId);
        jobIds.push(jobId);
      }

      return { styleId, batchId, jobIds };
    });

    return runApply();
  }
}

export const presetService = new PresetServiceImpl();
