-- lib/database/migrations/004_add_unique_constraint_on_assets.sql

-- Step 1: Remove duplicates, keeping one row per image_path.
-- NULL image_path rows are NEVER eligible for deletion (outer guard).
-- Active rows (is_deleted = 0) win ties over soft-deleted rows.
-- Among rows with the same is_deleted value, the earliest created_at wins.
DELETE FROM assets
WHERE image_path IS NOT NULL
AND id NOT IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY image_path
      ORDER BY is_deleted ASC, created_at ASC
    ) AS rn
    FROM assets
    WHERE image_path IS NOT NULL
  ) WHERE rn = 1
);

-- Step 2: Now safe to enforce uniqueness going forward.
CREATE UNIQUE INDEX idx_assets_image_path ON assets(image_path);
