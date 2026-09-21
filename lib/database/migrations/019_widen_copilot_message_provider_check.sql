-- lib/database/migrations/019_widen_copilot_message_provider_check.sql
--
-- Migration 016 hardcoded copilot_messages.provider CHECK (... IN ('claude',
-- 'ollama')). Adding OpenRouter as a third copilot provider widened the Zod
-- CopilotMessageSchema, but SQLite CHECK constraints can't be altered in
-- place -- the DB still rejects 'openrouter' at insert time (caught live:
-- "CHECK constraint failed: provider IN ('claude', 'ollama')"). Same
-- rebuild-and-rename fix as migration 010. No FK points at copilot_messages
-- itself (copilot_conversations is untouched), so only this one table needs
-- rebuilding.

CREATE TABLE copilot_messages_new (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES copilot_conversations(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  tool_call TEXT,
  provider TEXT CHECK (provider IN ('claude', 'ollama', 'openrouter')),
  model TEXT,
  created_at INTEGER NOT NULL
);

INSERT INTO copilot_messages_new (id, conversation_id, role, content, tool_call, provider, model, created_at)
SELECT id, conversation_id, role, content, tool_call, provider, model, created_at FROM copilot_messages;

DROP TABLE copilot_messages;
ALTER TABLE copilot_messages_new RENAME TO copilot_messages;

CREATE INDEX idx_copilot_messages_conversation_id ON copilot_messages(conversation_id);
