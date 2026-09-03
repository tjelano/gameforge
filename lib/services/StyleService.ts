import crypto from 'crypto';
import { DatabaseConnection } from '@/lib/database';
import { StyleSchema, type Style } from '@/lib/database/schema';

class StyleServiceImpl {
  /** Every style row, active and soft-deleted alike. Used for Git export. */
  async getAll(): Promise<Style[]> {
    const db = DatabaseConnection.getInstance();
    const rows = db.prepare('SELECT * FROM styles ORDER BY created_at DESC').all();
    return rows.map(row => StyleSchema.parse(row));
  }

  async getActiveStyles(): Promise<Style[]> {
    const db = DatabaseConnection.getInstance();
    const rows = db.prepare('SELECT * FROM styles WHERE is_deleted = 0 ORDER BY created_at DESC').all();
    return rows.map(row => StyleSchema.parse(row));
  }

  async getById(id: string): Promise<Style | null> {
    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT * FROM styles WHERE id = ?').get(id);
    return row ? StyleSchema.parse(row) : null;
  }

  async create(input: { name: string; createdBy: string; parameters: string; forkedFrom?: string | null }): Promise<Style> {
    const db = DatabaseConnection.getInstance();
    const id = crypto.randomUUID();
    const now = Date.now();
    db.prepare(`
      INSERT INTO styles (id, name, created_by, parameters, forked_from, is_deleted, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    `).run(id, input.name, input.createdBy, input.parameters, input.forkedFrom ?? null, now, now);
    return (await this.getById(id))!;
  }

  /** Only the creator may edit a style. Everyone else must Fork. */
  async update(
    id: string,
    requestingUserId: string,
    patch: { name?: string; parameters?: string }
  ): Promise<Style | { error: 'NOT_FOUND' | 'FORBIDDEN' }> {
    const existing = await this.getById(id);
    if (!existing) return { error: 'NOT_FOUND' };
    if (existing.created_by !== requestingUserId) return { error: 'FORBIDDEN' };

    const db = DatabaseConnection.getInstance();
    db.prepare(`
      UPDATE styles SET name = ?, parameters = ?, updated_at = ? WHERE id = ?
    `).run(
      patch.name ?? existing.name,
      patch.parameters ?? existing.parameters,
      Date.now(),
      id
    );
    return (await this.getById(id))!;
  }

  async softDelete(id: string): Promise<void> {
    const db = DatabaseConnection.getInstance();
    db.prepare('UPDATE styles SET is_deleted = 1, updated_at = ? WHERE id = ?').run(Date.now(), id);
  }

  /**
   * Forks a style into a brand-new one: same `parameters`, new id, new
   * owner, zero assets (a "blank canvas" — assets belong to the
   * original style's id and are never copied). The original is never
   * modified, per the Fork hard rule.
   */
  async fork(id: string, newOwnerId: string): Promise<Style | { error: 'NOT_FOUND' }> {
    const original = await this.getById(id);
    if (!original) return { error: 'NOT_FOUND' };
    return this.create({
      name: `${original.name} (fork)`,
      createdBy: newOwnerId,
      parameters: original.parameters,
      forkedFrom: original.id,
    });
  }
}

export const styleService = new StyleServiceImpl();
