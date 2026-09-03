import crypto from 'crypto';
import { DatabaseConnection } from '@/lib/database';
import { JobSchema, type Job } from '@/lib/database/schema';

const ACTIVE_WINDOW_MS = 5 * 60 * 1000; // 5-minute window for recently-finished jobs

class JobServiceImpl {
  async getById(id: string): Promise<Job | null> {
    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    return row ? JobSchema.parse(row) : null;
  }

  /**
   * In-flight jobs (pending/processing), plus jobs that reached a
   * terminal state within the last 5 minutes — so the dashboard's
   * polling hook can show "just finished" without polling every job
   * ever created. UI sheet jobs (options.pieces is a non-empty array)
   * are always included regardless of age, since a completed sheet
   * needs to stay reachable for Split/Promote/Discard until the user
   * acts on it — checked structurally via JSON1, not via asset_type
   * (which is display-label-only, not a contract).
   */
  async getActive(): Promise<Job[]> {
    const db = DatabaseConnection.getInstance();
    const rows = db.prepare(`
      SELECT * FROM jobs
      WHERE status IN ('pending', 'processing')
      OR (status IN ('complete', 'failed', 'promoted', 'discarded') AND updated_at > ?)
      OR (status IN ('complete', 'failed', 'promoted', 'discarded')
          AND json_array_length(json_extract(options, '$.pieces')) > 0)
      ORDER BY created_at DESC
    `).all(Date.now() - ACTIVE_WINDOW_MS);
    return rows.map(row => JobSchema.parse(row));
  }

  async create(input: {
    styleId: string;
    createdBy: string;
    assetType: string;
    prompt: string;
    options?: Record<string, unknown>;
  }): Promise<Job> {
    const db = DatabaseConnection.getInstance();
    const id = crypto.randomUUID();
    const now = Date.now();
    db.prepare(`
      INSERT INTO jobs (id, style_id, created_by, asset_type, prompt, status, result_path, created_at, updated_at, options)
      VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?)
    `).run(id, input.styleId, input.createdBy, input.assetType, input.prompt, now, now, JSON.stringify(input.options ?? {}));
    return (await this.getById(id))!;
  }

  /** Resets a job back to pending so the worker picks it up again. Clears result_path — the caller is responsible for freeing the old image file first via a shared safety helper. */
  async resetForRetry(id: string): Promise<Job | null> {
    const db = DatabaseConnection.getInstance();
    db.prepare(`UPDATE jobs SET status = 'pending', result_path = NULL, updated_at = ? WHERE id = ?`)
      .run(Date.now(), id);
    return this.getById(id);
  }

  async delete(id: string): Promise<void> {
    const db = DatabaseConnection.getInstance();
    db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
  }
}

export const jobService = new JobServiceImpl();
