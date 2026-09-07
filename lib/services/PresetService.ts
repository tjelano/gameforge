import crypto from 'crypto';
import { DatabaseConnection } from '@/lib/database';
import { PresetSchema, type Preset } from '@/lib/database/schema';

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
}

export const presetService = new PresetServiceImpl();
