# LiDAR Data Acquisition Guide

This is a **human-assisted** step. The Environment Agency LiDAR data must be downloaded manually.

## Data Source

**Environment Agency Open Data - LiDAR Composite**
- Portal: https://environment.data.gov.uk/DefraDataDownload/?Mode=survey
- License: Open Government Licence v3.0

## AOI Coverage

```
Buffered AOI bounds (EPSG:27700):
  Easting:  427,955 to 433,955
  Northing: 578,030 to 584,030

Centre: 430,955 E, 581,030 N (Broadway Circle, Blyth)
```

## Required Tiles

**4 tiles are needed for each dataset (8 total downloads):**

| Tile | Easting Range | Northing Range |
|------|---------------|----------------|
| NZ27NE | 425,000 - 430,000 | 575,000 - 580,000 |
| NZ28SE | 425,000 - 430,000 | 580,000 - 585,000 |
| NZ37NW | 430,000 - 435,000 | 575,000 - 580,000 |
| NZ38SW | 430,000 - 435,000 | 580,000 - 585,000 |

```
         NZ28SE          NZ38SW
      ┌───────────┬───────────┐ 585,000 N
      │           │           │
      │  (west)   │  (east)   │
      │           │           │
      ├───────────┼───────────┤ 580,000 N
      │           │           │
      │  NZ27NE   │  NZ37NW   │
      │           │           │
      └───────────┴───────────┘ 575,000 N
   425,000 E   430,000 E   435,000 E
```

## Download Checklist

### DTM (Digital Terrain Model) - 1m

- [ ] `LIDAR-DTM-1M-NZ27NE.tif`
- [ ] `LIDAR-DTM-1M-NZ28SE.tif`
- [ ] `LIDAR-DTM-1M-NZ37NW.tif`
- [ ] `LIDAR-DTM-1M-NZ38SW.tif`

### DSM (Digital Surface Model) - 1m

- [ ] `LIDAR-DSM-1M-NZ27NE.tif`
- [ ] `LIDAR-DSM-1M-NZ28SE.tif`
- [ ] `LIDAR-DSM-1M-NZ37NW.tif`
- [ ] `LIDAR-DSM-1M-NZ38SW.tif`

## Download Steps

1. Visit https://environment.data.gov.uk/DefraDataDownload/?Mode=survey

2. In the map, navigate to **Blyth, Northumberland** (NE24 area)

3. Use the layer selector to enable:
   - "LIDAR Composite DTM - 1m"

4. Click on the map to select tiles. You need tiles covering:
   - Grid references: NZ27, NZ28, NZ37, NZ38 (the portal shows 10km tiles)

5. Download all 4 DTM tiles

6. Switch to "LIDAR Composite DSM - 1m" layer

7. Download the same 4 tiles for DSM

8. Extract ZIP files and place GeoTIFFs in the correct directories

## File Storage

```
data/raw/lidar_dtm/
  ├── LIDAR-DTM-1M-NZ27NE.tif
  ├── LIDAR-DTM-1M-NZ28SE.tif
  ├── LIDAR-DTM-1M-NZ37NW.tif
  └── LIDAR-DTM-1M-NZ38SW.tif

data/raw/lidar_dsm/
  ├── LIDAR-DSM-1M-NZ27NE.tif
  ├── LIDAR-DSM-1M-NZ28SE.tif
  ├── LIDAR-DSM-1M-NZ37NW.tif
  └── LIDAR-DSM-1M-NZ38SW.tif
```

**Note:** Actual filenames from EA may vary (e.g., include year like `LIDAR-DTM-1M-2022-NZ38sw.tif`). Any `.tif` files in the directories will be processed.

## Verification

After downloading, verify the files:

```bash
cd /root/dad/blyth-twin/data/raw

# Check file count
ls -la lidar_dtm/*.tif
ls -la lidar_dsm/*.tif

# Verify CRS (should show EPSG:27700)
gdalinfo lidar_dtm/*.tif | grep -E "CRS|EPSG"

# Generate checksums
sha256sum lidar_dtm/*.tif > lidar_dtm/checksums.sha256
sha256sum lidar_dsm/*.tif > lidar_dsm/checksums.sha256
```

## Expected File Sizes

Each 5km x 5km tile at 1m resolution:
- Uncompressed: ~25 MB per tile
- Total: ~200 MB for all 8 tiles

## Notes

- Heights are in metres relative to Ordnance Datum Newlyn (ODN)
- Resolution: 1 metre
- CRS: EPSG:27700 (British National Grid)
- Some coastal/sea areas may have NoData values - this is expected
- The pipeline (`30_prepare_rasters.py`) will automatically merge tiles

## Alternative: Direct API Access

If you have `curl` and know the exact file URLs, you can download directly:

```bash
# Example (URLs will vary by year/version):
# curl -O "https://environment.data.gov.uk/.../LIDAR-DTM-1M-2022-NZ38sw.zip"
```

Check the EA Data Services API documentation for programmatic access.
