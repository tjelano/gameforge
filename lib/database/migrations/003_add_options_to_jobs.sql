-- lib/database/migrations/003_add_options_to_jobs.sql

ALTER TABLE jobs ADD COLUMN options TEXT NOT NULL DEFAULT '{}';
