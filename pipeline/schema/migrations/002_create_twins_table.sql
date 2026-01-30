-- Migration 002: Create twins table for on-demand digital twin creation
--
-- Run with: psql -d blyth_twin -f 002_create_twins_table.sql

-- ============================================================================
-- ENABLE UUID EXTENSION
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- TWINS TABLE
-- ============================================================================
-- Stores digital twin definitions and pipeline execution status

CREATE TABLE IF NOT EXISTS twins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    location_name VARCHAR(255),

    -- AOI definition (center point + dimensions)
    centre_lat DOUBLE PRECISION NOT NULL,
    centre_lon DOUBLE PRECISION NOT NULL,
    side_length_m INTEGER NOT NULL DEFAULT 2000,
    buffer_m INTEGER NOT NULL DEFAULT 500,

    -- Pipeline execution status
    status VARCHAR(50) DEFAULT 'pending',  -- pending, running, completed, failed
    current_step VARCHAR(100),
    progress_pct INTEGER DEFAULT 0,
    error_message TEXT,

    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    started_at TIMESTAMP,
    completed_at TIMESTAMP,

    -- Output info
    output_dir VARCHAR(255) UNIQUE,
    building_count INTEGER,

    -- LiDAR availability
    has_lidar BOOLEAN DEFAULT FALSE,
    height_source VARCHAR(50) DEFAULT 'osm',  -- lidar, osm_levels, default

    -- Constraints
    CONSTRAINT valid_status CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    CONSTRAINT valid_progress CHECK (progress_pct >= 0 AND progress_pct <= 100),
    CONSTRAINT valid_side_length CHECK (side_length_m > 0 AND side_length_m <= 10000),
    CONSTRAINT valid_buffer CHECK (buffer_m >= 0 AND buffer_m <= 2000)
);

-- ============================================================================
-- INDEXES
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_twins_status ON twins(status);
CREATE INDEX IF NOT EXISTS idx_twins_created_at ON twins(created_at DESC);

-- ============================================================================
-- TRIGGER: Update timestamps
-- ============================================================================

DROP TRIGGER IF EXISTS update_twins_updated_at ON twins;

-- Note: We don't have an updated_at column in twins, but add it for consistency
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'twins' AND column_name = 'updated_at'
    ) THEN
        ALTER TABLE twins ADD COLUMN updated_at TIMESTAMP DEFAULT NOW();
    END IF;
END $$;

CREATE TRIGGER update_twins_updated_at
    BEFORE UPDATE ON twins
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- DONE
-- ============================================================================

SELECT 'Migration 002 complete: twins table created' as status;
