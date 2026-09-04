-- lib/database/migrations/007_add_settings_table.sql

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
