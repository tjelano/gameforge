-- lib/database/migrations/008_add_output_kind.sql

ALTER TABLE jobs ADD COLUMN output_kind TEXT NOT NULL DEFAULT 'image' CHECK (output_kind IN ('image', 'theme'));
ALTER TABLE assets ADD COLUMN output_kind TEXT NOT NULL DEFAULT 'image' CHECK (output_kind IN ('image', 'theme'));
