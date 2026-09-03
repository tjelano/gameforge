
ALTER TABLE assets ADD COLUMN source_job_id TEXT REFERENCES jobs(id);
ALTER TABLE assets ADD COLUMN nine_slice_margins TEXT;
ALTER TABLE assets ADD COLUMN states TEXT NOT NULL DEFAULT '[]';

CREATE INDEX idx_assets_source_job_id ON assets(source_job_id);
