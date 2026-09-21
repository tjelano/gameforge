CREATE TABLE inspo_reference_cache (
  id TEXT PRIMARY KEY,
  style_id TEXT NOT NULL REFERENCES styles(id) ON DELETE CASCADE,
  component_type TEXT NOT NULL,
  accent_hash TEXT NOT NULL,
  image_url TEXT NOT NULL,
  is_fallback INTEGER NOT NULL DEFAULT 0,
  is_color_matched INTEGER NOT NULL DEFAULT 0,
  fetched_at INTEGER NOT NULL,
  UNIQUE(style_id, component_type, accent_hash)
);

CREATE INDEX idx_inspo_reference_cache_style_id ON inspo_reference_cache(style_id);
