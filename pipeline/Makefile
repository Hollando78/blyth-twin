# Blyth Digital Twin Pipeline
# Usage: make <target>

SHELL := /bin/bash
PYTHON := python3
VENV := .venv
SCRIPTS := scripts
DATA := ../data
CONFIG := config

.PHONY: all setup fetch_osm process pack validate clean help

# Default target
all: setup fetch_osm process pack validate

# Create virtual environment and install dependencies
setup:
	@echo "Setting up Python virtual environment..."
	$(PYTHON) -m venv $(VENV)
	$(VENV)/bin/pip install --upgrade pip
	$(VENV)/bin/pip install -r requirements.txt
	@echo "Setup complete. Activate with: source $(VENV)/bin/activate"

# Generate AOI boundaries
aoi:
	@echo "Generating AOI..."
	$(VENV)/bin/python $(SCRIPTS)/00_aoi.py

# Fetch OSM vector data
fetch_osm: aoi
	@echo "Fetching OSM data..."
	$(VENV)/bin/python $(SCRIPTS)/20_fetch_osm.py

# Prepare rasters (merge, warp, clip)
prepare_rasters:
	@echo "Preparing rasters..."
	$(VENV)/bin/python $(SCRIPTS)/30_prepare_rasters.py

# Compute normalized DSM
compute_ndsm: prepare_rasters
	@echo "Computing nDSM..."
	$(VENV)/bin/python $(SCRIPTS)/40_compute_ndsm.py

# Derive building heights
building_heights: compute_ndsm fetch_osm
	@echo "Deriving building heights..."
	$(VENV)/bin/python $(SCRIPTS)/50_building_heights.py

# Generate meshes
meshes: building_heights
	@echo "Generating meshes..."
	$(VENV)/bin/python $(SCRIPTS)/60_generate_meshes.py

# Full processing pipeline
process: prepare_rasters compute_ndsm building_heights meshes

# Pack assets for web delivery
pack: meshes
	@echo "Packing assets..."
	$(VENV)/bin/python $(SCRIPTS)/70_pack_assets.py

# Run validation and generate report
validate:
	@echo "Running validation..."
	$(VENV)/bin/python $(SCRIPTS)/90_validate.py

# Clean generated files
clean:
	@echo "Cleaning generated files..."
	rm -rf $(DATA)/interim/*
	rm -rf $(DATA)/processed/*
	rm -rf ../dist/blyth_mvp_v1/assets/*
	rm -rf ../dist/blyth_mvp_v1/report/*

# Show help
help:
	@echo "Blyth Digital Twin Pipeline"
	@echo ""
	@echo "Targets:"
	@echo "  setup          - Create venv and install dependencies"
	@echo "  aoi            - Generate AOI boundaries"
	@echo "  fetch_osm      - Download OSM vectors"
	@echo "  prepare_rasters - Merge and clip LiDAR rasters"
	@echo "  compute_ndsm   - Calculate normalized DSM"
	@echo "  building_heights - Derive building heights"
	@echo "  meshes         - Generate terrain and building meshes"
	@echo "  process        - Run full processing pipeline"
	@echo "  pack           - Package assets for web"
	@echo "  validate       - Run QA validation"
	@echo "  clean          - Remove generated files"
	@echo "  all            - Run complete pipeline"
