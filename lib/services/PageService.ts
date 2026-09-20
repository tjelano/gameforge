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

  /** Only the creator, or an admin, may edit a page. Mirrors StyleService.update(). */
  async update(
    id: string,
    requestingUserId: string,
    patch: {
      name?: string;
      componentAssetIds?: string;
    },
    isAdmin: boolean = false
  ): Promise<Page | { error: 'NOT_FOUND' | 'FORBIDDEN' }> {
    const existing = await this.getById(id);
    if (!existing) return { error: 'NOT_FOUND' };
    if (existing.created_by !== requestingUserId && !isAdmin) return { error: 'FORBIDDEN' };
    const db = DatabaseConnection.getInstance();
    db.prepare(`
      UPDATE pages SET name = ?, component_asset_ids = ?, updated_at = ? WHERE id = ?
    `).run(
      patch.name ?? existing.name,
      patch.componentAssetIds ?? existing.component_asset_ids,
      Date.now(),
      id
    );
    return (await this.getById(id))!;
  }

  /** Only the creator, or an admin, may delete a page. Mirrors update() above. */
  async softDelete(id: string, requestingUserId: string, isAdmin: boolean = false): Promise<void | { error: 'NOT_FOUND' | 'FORBIDDEN' }> {
    const existing = await this.getById(id);
    if (!existing) return { error: 'NOT_FOUND' };
    if (existing.created_by !== requestingUserId && !isAdmin) return { error: 'FORBIDDEN' };
    const db = DatabaseConnection.getInstance();
    db.prepare('UPDATE pages SET is_deleted = 1, updated_at = ? WHERE id = ?').run(Date.now(), id);
  }

  /**
   * Active pages whose component_asset_ids includes assetId — for warning a user before they
   * discard a component that a page still relies on. `LIKE '%"<id>"%'` on the stored JSON array
   * string is safe only because asset ids are always `crypto.randomUUID()` output (lowercase hex,
   * no `"`/`%`/`_`) from `AssetService.create()` — never user-typed. Not scoped by requesting user:
   * every other read on this service (getAll, getActivePagesForStyle, getById) is unscoped too,
   * only mutations (update/softDelete) enforce ownership.
   */
  async findPagesReferencingAsset(assetId: string): Promise<Page[]> {
    const db = DatabaseConnection.getInstance();
    const rows = db.prepare(
      'SELECT * FROM pages WHERE is_deleted = 0 AND component_asset_ids LIKE ? ORDER BY created_at DESC, id'
    ).all(`%"${assetId}"%`);
    return rows.map(row => PageSchema.parse(row));
  }
}

export const pageService = new PageServiceImpl();
