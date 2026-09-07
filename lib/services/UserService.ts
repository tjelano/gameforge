import crypto from 'crypto';
import { DatabaseConnection } from '@/lib/database';
import { UserSchema, type User } from '@/lib/database/schema';

class UserServiceImpl {
  async getAll(): Promise<User[]> {
    const db = DatabaseConnection.getInstance();
    const rows = db.prepare('SELECT * FROM users ORDER BY created_at ASC').all();
    return rows.map(row => UserSchema.parse(row));
  }

  /** No soft-delete concept for users (unlike styles/assets) — this exists
   *  so call sites can express "the users I'd show someone" without
   *  assuming getAll()'s ordering/shape is stable long-term. */
  async getActiveUsers(): Promise<User[]> {
    return this.getAll();
  }

  async getById(id: string): Promise<User | null> {
    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    return row ? UserSchema.parse(row) : null;
  }

  async getByName(name: string): Promise<User | null> {
    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT * FROM users WHERE name = ?').get(name);
    return row ? UserSchema.parse(row) : null;
  }

  /** The first user ever created (globally, via the synced `users` table —
   *  see the spec's "First-run and the git-sync race" section for why this
   *  check alone is not sufficient at the route layer) becomes admin. */
  async create(input: { name: string }): Promise<User> {
    const db = DatabaseConnection.getInstance();
    const id = crypto.randomUUID();
    const now = Date.now();
    const existingCount = (db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }).count;
    const isAdmin = existingCount === 0 ? 1 : 0;
    db.prepare('INSERT INTO users (id, name, is_admin, created_at) VALUES (?, ?, ?, ?)')
      .run(id, input.name, isAdmin, now);
    return (await this.getById(id))!;
  }
}

export const userService = new UserServiceImpl();
