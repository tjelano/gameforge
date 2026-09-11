-- lib/database/migrations/014_add_edited_externally_to_assets.sql

ALTER TABLE assets ADD COLUMN edited_externally INTEGER NOT NULL DEFAULT 0;
