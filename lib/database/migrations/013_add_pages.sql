CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  style_id TEXT NOT NULL REFERENCES styles(id),
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  component_asset_ids TEXT NOT NULL DEFAULT '[]',
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_pages_style_id ON pages(style_id);
