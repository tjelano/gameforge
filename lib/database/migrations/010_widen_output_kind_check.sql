-- lib/database/migrations/010_widen_output_kind_check.sql
--
-- Migration 008 hardcoded output_kind CHECK (... IN ('image', 'theme')) on
-- both jobs and assets. Task 1 of the component-generation plan widened the
-- Zod OutputKindSchema to include 'component', but SQLite CHECK constraints
-- can't be altered in place -- the DB still rejects 'component' at insert
-- time. SQLite has no ALTER TABLE ... DROP CONSTRAINT, so the standard fix
-- is: build a new table with the wider CHECK, copy the data across, drop
-- the old table, rename the new one into place. jobs is rebuilt before
-- assets since assets.source_job_id references jobs(id) by name -- as long
-- as a table named "jobs" exists by the time assets_new is populated, the
-- foreign key resolves fine for that INSERT.
--
-- That ordering alone is NOT what makes DROP TABLE jobs safe, though: with
-- foreign_keys=ON, DROP TABLE performs an implicit DELETE FROM first, and
-- any assets row whose source_job_id still points at a job (a real,
-- already-shipped shape -- see app/api/assets/from-crop/route.ts) would
-- make that implicit delete violate the FK, failing the whole migration.
-- Since PRAGMA foreign_keys is a no-op mid-transaction, this migration's
-- own SQL can't disable it -- the actual fix lives in
-- lib/database/index.ts's runMigrations(), which disables foreign_keys for
-- the duration of running all pending migration files (restoring it after)
-- and runs PRAGMA foreign_key_check before each COMMIT as a safety net.

CREATE TABLE jobs_new (
  id TEXT PRIMARY KEY,
  style_id TEXT NOT NULL REFERENCES styles(id),
  created_by TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'complete', 'promoted', 'discarded', 'failed')),
  result_path TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  options TEXT NOT NULL DEFAULT '{}',
  output_kind TEXT NOT NULL DEFAULT 'image' CHECK (output_kind IN ('image', 'theme', 'component')),
  batch_id TEXT
);

INSERT INTO jobs_new (id, style_id, created_by, asset_type, prompt, status, result_path, created_at, updated_at, options, output_kind, batch_id)
SELECT id, style_id, created_by, asset_type, prompt, status, result_path, created_at, updated_at, options, output_kind, batch_id FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;

CREATE INDEX idx_jobs_style_id ON jobs(style_id);
CREATE INDEX idx_jobs_status ON jobs(status);

CREATE TABLE assets_new (
  id TEXT PRIMARY KEY,
  style_id TEXT NOT NULL REFERENCES styles(id),
  created_by TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  prompt TEXT NOT NULL,
  image_path TEXT,
  created_at INTEGER NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  source_job_id TEXT REFERENCES jobs(id),
  nine_slice_margins TEXT,
  states TEXT NOT NULL DEFAULT '[]',
  output_kind TEXT NOT NULL DEFAULT 'image' CHECK (output_kind IN ('image', 'theme', 'component'))
);

INSERT INTO assets_new (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted, source_job_id, nine_slice_margins, states, output_kind)
SELECT id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted, source_job_id, nine_slice_margins, states, output_kind FROM assets;

DROP TABLE assets;
ALTER TABLE assets_new RENAME TO assets;

CREATE INDEX idx_assets_style_id ON assets(style_id);
CREATE INDEX idx_assets_is_deleted ON assets(is_deleted);
CREATE UNIQUE INDEX idx_assets_image_path ON assets(image_path);
CREATE INDEX idx_assets_source_job_id ON assets(source_job_id);
