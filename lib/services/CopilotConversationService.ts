import crypto from 'crypto';
import { DatabaseConnection } from '@/lib/database';
import { CopilotConversationSchema, type CopilotConversation } from '@/lib/database/schema';

class CopilotConversationServiceImpl {
  async create(input: { title: string; createdBy: string }): Promise<CopilotConversation> {
    const db = DatabaseConnection.getInstance();
    const id = crypto.randomUUID();
    const now = Date.now();
    db.prepare(`
      INSERT INTO copilot_conversations (id, title, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, input.title, input.createdBy, now, now);
    return (await this.getById(id))!;
  }

  async getById(id: string): Promise<CopilotConversation | null> {
    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT * FROM copilot_conversations WHERE id = ?').get(id);
    return row ? CopilotConversationSchema.parse(row) : null;
  }

  /** This user's conversations, most-recently-active first. */
  async listForUser(userId: string): Promise<CopilotConversation[]> {
    const db = DatabaseConnection.getInstance();
    const rows = db.prepare(
      'SELECT * FROM copilot_conversations WHERE created_by = ? ORDER BY updated_at DESC'
    ).all(userId);
    return rows.map(row => CopilotConversationSchema.parse(row));
  }

  /** Called once per message turn so the conversation list sorts by recent activity, not just creation. */
  async touch(id: string): Promise<void> {
    const db = DatabaseConnection.getInstance();
    db.prepare('UPDATE copilot_conversations SET updated_at = ? WHERE id = ?').run(Date.now(), id);
  }
}

export const copilotConversationService = new CopilotConversationServiceImpl();
