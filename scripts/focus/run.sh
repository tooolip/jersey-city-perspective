#!/bin/sh
# Builds (or rebuilds) one focus area end to end. Usage: sh scripts/focus/run.sh example-area
set -e
AREA="$1"
PY=".venv/bin/python -I"
[ -f "areas/$AREA.json" ] || { echo "no areas/$AREA.json"; exit 1; }
$PY scripts/focus/fetch-3d.py "$AREA"      # photos, poses, SfM reconstructions (cached)
node scripts/build-data.mjs > /dev/null      # scene without this area's corrections
$PY scripts/focus/register.py "$AREA"      # register reconstructions to the footprints
$PY scripts/focus/build-focus.py "$AREA"   # photo poses aligned to terrain + footprints
$PY scripts/focus/terrain.py "$AREA"       # street level, plateaus, cuts
$PY scripts/focus/streets.py "$AREA"       # measured curbs
node scripts/build-data.mjs > /dev/null      # scene with corrections
$PY scripts/focus/facades.py "$AREA"       # photo-textured walls (needs the final scene)
