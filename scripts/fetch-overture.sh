#!/bin/sh
# Downloads Overture Maps building footprints (with USGS LiDAR / ML heights).
# Requires the Overture CLI: python3 -m venv .venv && .venv/bin/pip install overturemaps
set -e
OVERTURE="${OVERTURE:-.venv/bin/overturemaps}"
mkdir -p data/raw

# Jersey City downtown (project area plus margin)
"$OVERTURE" download --bbox=-74.060,40.713,-74.024,40.735 -f geojson --type=building \
  -o data/raw/overture_buildings_jc.geojson

# Lower / Midtown-south Manhattan skyline across the Hudson (backdrop only)
"$OVERTURE" download --bbox=-74.022,40.698,-73.990,40.745 -f geojson --type=building \
  -o data/raw/overture_buildings_manhattan.geojson
