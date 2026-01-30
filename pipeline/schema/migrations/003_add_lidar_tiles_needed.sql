-- Migration 003: Add tiles_needed column and awaiting_lidar status
--
-- Run with: psql -d blyth_twin -f 003_add_lidar_tiles_needed.sql

-- ============================================================================
-- ADD tiles_needed COLUMN
-- ============================================================================
-- Stores list of OS National Grid tile references needed for LiDAR

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'twins' AND column_name = 'tiles_needed'
    ) THEN
        ALTER TABLE twins ADD COLUMN tiles_needed JSONB DEFAULT '[]'::jsonb;
    END IF;
END $$;

-- ============================================================================
-- UPDATE STATUS CONSTRAINT
-- ============================================================================
-- Add 'awaiting_lidar' as a valid status

ALTER TABLE twins DROP CONSTRAINT IF EXISTS valid_status;
ALTER TABLE twins ADD CONSTRAINT valid_status
    CHECK (status IN ('pending', 'running', 'awaiting_lidar', 'completed', 'failed'));

-- ============================================================================
-- DONE
-- ============================================================================

SELECT 'Migration 003 complete: tiles_needed column and awaiting_lidar status added' as status;
