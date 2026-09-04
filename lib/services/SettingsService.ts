import { DatabaseConnection } from '@/lib/database';

class SettingsServiceImpl {
  async get(key: string): Promise<string | null> {
    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  async set(key: string, value: string): Promise<void> {
    const db = DatabaseConnection.getInstance();
    db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }
}

export const settingsService = new SettingsServiceImpl();
