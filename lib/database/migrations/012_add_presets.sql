CREATE TABLE presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  prompt TEXT NOT NULL,
  tech_stack_tags TEXT NOT NULL DEFAULT '[]',
  theme_prompt TEXT,
  components TEXT NOT NULL DEFAULT '[]',
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
