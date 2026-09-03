-- lib/database/migrations/002_add_is_deleted_to_assets.sql

ALTER TABLE assets ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_assets_is_deleted ON assets(is_deleted);
