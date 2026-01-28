-- Migration 001: Create building_overrides and building_meshes tables
-- Phase 2: User Edit Infrastructure
--
-- Run with: psql -d blyth_twin -f 001_create_overrides_tables.sql

-- ============================================================================
-- BUILDING OVERRIDES TABLE
-- ============================================================================
-- Stores user edits to building properties. Keeps OSM data pristine.
-- NULL values mean "use the base OSM value"

CREATE TABLE IF NOT EXISTS building_overrides (
    id SERIAL PRIMARY KEY,
    building_id INTEGER,  -- References buildings(id), but allow orphans for flexibility
    osm_id BIGINT NOT NULL,

    -- Overridable properties (NULL = use base value)
    height REAL,
    height_source VARCHAR(50),
    name VARCHAR(255),
    building_type VARCHAR(100),
    addr_housenumber VARCHAR(50),
    addr_street VARCHAR(255),
    addr_postcode VARCHAR(20),
    addr_city VARCHAR(100),

    -- Geometry override (NULL = use base footprint)
    geometry GEOMETRY(Polygon, 27700),

    -- Audit fields
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    created_by VARCHAR(100),
    edit_note TEXT,

    -- Ensure one override per building
    UNIQUE(osm_id)
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_overrides_osm_id ON building_overrides(osm_id);
CREATE INDEX IF NOT EXISTS idx_overrides_building_id ON building_overrides(building_id);


-- ============================================================================
-- BUILDING MESHES TABLE
-- ============================================================================
-- Stores custom 3D meshes that replace procedural generation.
-- Either inline GLB data or external URL.

CREATE TABLE IF NOT EXISTS building_meshes (
    id SERIAL PRIMARY KEY,
    osm_id BIGINT NOT NULL UNIQUE,

    -- Mesh data (one of these should be set)
    glb_data BYTEA,                    -- Inline GLB binary
    glb_url VARCHAR(500),              -- Or external URL

    -- Mesh metadata
    vertex_count INTEGER,
    face_count INTEGER,
    bounds_min_x REAL,
    bounds_min_y REAL,
    bounds_min_z REAL,
    bounds_max_x REAL,
    bounds_max_y REAL,
    bounds_max_z REAL,

    -- Source info
    mesh_source VARCHAR(50),           -- 'user_upload', 'meshy_ai', 'gemini', 'manual'
    source_reference VARCHAR(500),     -- Original file, API job ID, etc.

    -- Audit fields
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    created_by VARCHAR(100),

    -- Constraint: must have either glb_data or glb_url
    CONSTRAINT mesh_data_check CHECK (glb_data IS NOT NULL OR glb_url IS NOT NULL)
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_meshes_osm_id ON building_meshes(osm_id);
CREATE INDEX IF NOT EXISTS idx_meshes_source ON building_meshes(mesh_source);


-- ============================================================================
-- AUDIT COLUMNS ON BUILDINGS (if not already added)
-- ============================================================================

DO $$
BEGIN
    -- Add created_at if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'buildings' AND column_name = 'created_at'
    ) THEN
        ALTER TABLE buildings ADD COLUMN created_at TIMESTAMP DEFAULT NOW();
    END IF;

    -- Add updated_at if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'buildings' AND column_name = 'updated_at'
    ) THEN
        ALTER TABLE buildings ADD COLUMN updated_at TIMESTAMP DEFAULT NOW();
    END IF;

    -- Add source if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'buildings' AND column_name = 'source'
    ) THEN
        ALTER TABLE buildings ADD COLUMN source VARCHAR(20) DEFAULT 'osm';
    END IF;
END $$;


-- ============================================================================
-- HELPER VIEW: Merged building data
-- ============================================================================
-- Combines base buildings with overrides for easy querying

CREATE OR REPLACE VIEW buildings_merged AS
SELECT
    b.id,
    b.osm_id,
    COALESCE(o.geometry, b.geometry) as geometry,
    COALESCE(o.height, b.height) as height,
    COALESCE(o.height_source, b.height_source) as height_source,
    b.levels,
    COALESCE(o.building_type, b.building_type) as building_type,
    COALESCE(o.name, b.name) as name,
    b.amenity,
    b.shop,
    b.office,
    COALESCE(o.addr_housenumber, b.addr_housenumber) as addr_housenumber,
    b.addr_housename,
    COALESCE(o.addr_street, b.addr_street) as addr_street,
    COALESCE(o.addr_postcode, b.addr_postcode) as addr_postcode,
    COALESCE(o.addr_city, b.addr_city) as addr_city,
    b.addr_suburb,
    b.tags,
    b.centroid,
    b.source,
    b.created_at,
    GREATEST(b.updated_at, o.updated_at) as updated_at,
    (o.id IS NOT NULL) as has_override,
    (m.id IS NOT NULL) as has_custom_mesh,
    o.edit_note,
    o.created_by as override_created_by
FROM buildings b
LEFT JOIN building_overrides o ON b.osm_id = o.osm_id
LEFT JOIN building_meshes m ON b.osm_id = m.osm_id;


-- ============================================================================
-- TRIGGER: Update updated_at timestamp
-- ============================================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for building_overrides
DROP TRIGGER IF EXISTS update_building_overrides_updated_at ON building_overrides;
CREATE TRIGGER update_building_overrides_updated_at
    BEFORE UPDATE ON building_overrides
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Trigger for building_meshes
DROP TRIGGER IF EXISTS update_building_meshes_updated_at ON building_meshes;
CREATE TRIGGER update_building_meshes_updated_at
    BEFORE UPDATE ON building_meshes
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Trigger for buildings
DROP TRIGGER IF EXISTS update_buildings_updated_at ON buildings;
CREATE TRIGGER update_buildings_updated_at
    BEFORE UPDATE ON buildings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();


-- ============================================================================
-- DONE
-- ============================================================================

SELECT 'Migration 001 complete: building_overrides and building_meshes tables created' as status;
