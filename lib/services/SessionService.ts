import crypto from 'crypto';
import { DatabaseConnection } from '@/lib/database';
import { UserSchema, type User } from '@/lib/database/schema';

const SESSION_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

class SessionServiceImpl {
  async create(userId: string): Promise<{ token: string; expiresAt: number }> {
    const db = DatabaseConnection.getInstance();
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    const expiresAt = now + SESSION_LIFETIME_MS;
    db.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(token, userId, expiresAt, now);
    return { token, expiresAt };
  }

  async getUserByToken(token: string): Promise<User | null> {
    const db = DatabaseConnection.getInstance();
    const row = db.prepare(`
      SELECT users.* FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.token = ? AND sessions.expires_at > ?
    `).get(token, Date.now());
    return row ? UserSchema.parse(row) : null;
  }

  async destroy(token: string): Promise<void> {
    const db = DatabaseConnection.getInstance();
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }
}

export const sessionService = new SessionServiceImpl();
