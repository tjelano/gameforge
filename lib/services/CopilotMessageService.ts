import crypto from 'crypto';
import { DatabaseConnection } from '@/lib/database';
import { CopilotMessageSchema, type CopilotMessage } from '@/lib/database/schema';

class CopilotMessageServiceImpl {
  async append(input: {
    conversationId: string;
    role: 'user' | 'assistant';
    content: string;
    toolCall?: { name: string; input: unknown };
    provider?: 'claude' | 'ollama';
    model?: string;
  }): Promise<CopilotMessage> {
    const db = DatabaseConnection.getInstance();
    const id = crypto.randomUUID();
    const now = Date.now();
    db.prepare(`
      INSERT INTO copilot_messages (id, conversation_id, role, content, tool_call, provider, model, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.conversationId,
      input.role,
      input.content,
      input.toolCall ? JSON.stringify(input.toolCall) : null,
      input.provider ?? null,
      input.model ?? null,
      now
    );
    const row = db.prepare('SELECT * FROM copilot_messages WHERE id = ?').get(id);
    return CopilotMessageSchema.parse(row);
  }

  /**
   * Oldest first — the natural order for replaying into a model's `messages`
   * array. `rowid` is SQLite's implicit insertion-order column (present on
   * every normal, non-WITHOUT-ROWID table, which this is); it's the
   * tiebreaker for two messages landing on the same created_at millisecond
   * (a real possibility: the route appends the user message, then the
   * assistant's reply, and a mocked/very fast model call in tests can make
   * both happen within the same tick) -- `created_at` alone doesn't
   * guarantee a stable order for ties.
   */
  async listByConversation(conversationId: string): Promise<CopilotMessage[]> {
    const db = DatabaseConnection.getInstance();
    const rows = db.prepare(
      'SELECT * FROM copilot_messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC'
    ).all(conversationId);
    return rows.map(row => CopilotMessageSchema.parse(row));
  }
}

export const copilotMessageService = new CopilotMessageServiceImpl();
