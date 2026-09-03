-- lib/database/migrations/001_init.sql

CREATE TABLE styles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  parameters TEXT NOT NULL DEFAULT '{}',
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  style_id TEXT NOT NULL REFERENCES styles(id),
  created_by TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  prompt TEXT NOT NULL,
  image_path TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  style_id TEXT NOT NULL REFERENCES styles(id),
  created_by TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'complete', 'promoted', 'discarded', 'failed')),
  result_path TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_assets_style_id ON assets(style_id);
CREATE INDEX idx_jobs_style_id ON jobs(style_id);
CREATE INDEX idx_jobs_status ON jobs(status);
