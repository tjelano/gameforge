-- lib/database/migrations/005_add_forked_from_to_styles.sql

ALTER TABLE styles ADD COLUMN forked_from TEXT REFERENCES styles(id);

CREATE INDEX idx_styles_forked_from ON styles(forked_from);
