import crypto from 'crypto';
import { DatabaseConnection } from '@/lib/database';
import { PageSchema, type Page } from '@/lib/database/schema';

class PageServiceImpl {
  /** Every page row, active and soft-deleted alike, across all styles. Used for Git export. */
  async getAll(): Promise<Page[]> {
    const db = DatabaseConnection.getInstance();
    const rows = db.prepare('SELECT * FROM pages ORDER BY created_at DESC').all();
    return rows.map(row => PageSchema.parse(row));
  }

  /** Active pages belonging to one Style Bible, newest first. */
  async getActivePagesForStyle(styleId: string): Promise<Page[]> {
    const db = DatabaseConnection.getInstance();
    const rows = db.prepare(
      'SELECT * FROM pages WHERE style_id = ? AND is_deleted = 0 ORDER BY created_at DESC'
    ).all(styleId);
    return rows.map(row => PageSchema.parse(row));
  }

  async getById(id: string): Promise<Page | null> {
    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT * FROM pages WHERE id = ?').get(id);
    return row ? PageSchema.parse(row) : null;
  }

  async create(input: { styleId: string; name: string; createdBy: string }): Promise<Page> {
    const db = DatabaseConnection.getInstance();
    const id = crypto.randomUUID();
    const now = Date.now();
    db.prepare(`
      INSERT INTO pages (id, style_id, name, created_by, component_asset_ids, is_deleted, created_at, updated_at)
      VALUES (?, ?, ?, ?, '[]', 0, ?, ?)
    `).run(id, input.styleId, input.name, input.createdBy, now, now);
    return (await this.getById(id))!;
  }

  /** No ownership check - pages are shared, any logged-in user may edit any page. */
  async update(id: string, patch: {
    name?: string;
    componentAssetIds?: string;
  }): Promise<Page | null> {
    const existing = await this.getById(id);
    if (!existing) return null;
    const db = DatabaseConnection.getInstance();
    db.prepare(`
      UPDATE pages SET name = ?, component_asset_ids = ?, updated_at = ? WHERE id = ?
    `).run(
      patch.name ?? existing.name,
      patch.componentAssetIds ?? existing.component_asset_ids,
      Date.now(),
      id
    );
    return this.getById(id);
  }

  async softDelete(id: string): Promise<void> {
    const db = DatabaseConnection.getInstance();
    db.prepare('UPDATE pages SET is_deleted = 1, updated_at = ? WHERE id = ?').run(Date.now(), id);
  }
}

export const pageService = new PageServiceImpl();
