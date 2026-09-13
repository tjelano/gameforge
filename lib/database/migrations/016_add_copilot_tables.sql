CREATE TABLE copilot_conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_copilot_conversations_created_by ON copilot_conversations(created_by);

CREATE TABLE copilot_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES copilot_conversations(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  tool_call TEXT,
  provider TEXT CHECK (provider IN ('claude', 'ollama')),
  model TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_copilot_messages_conversation_id ON copilot_messages(conversation_id);
