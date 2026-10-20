# Roadmap: true-to-life geometry and contents

Goal: model what is actually there, with real dimensions, storey counts, colours, signs and
street furniture. The art direction is open; correctness of the geometry and contents comes first.
Every feature should trace back to a data source, and estimates should be flagged as estimates.

## Verified data sources (checked against this area, Oct 2026)

| Source | What it gives us | Access | License |
|---|---|---|---|
| **NJ Parcels + MOD-IV tax records** ([service](https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/ArcGIS/rest/services/Parcels_Composite_NJ_WM/FeatureServer/0)) | ~12.4k parcels here: lot polygons, address, property class, **storeys** (`3S`, `2.5S`), units, construction hints (`B` brick, `F` frame), **year built**, lot frontage × depth (ft) | ArcGIS REST, 2000 records/page | NJ public record (owner names redacted; we don't download them) |
| **USDA NAIP 2023** ([Planetary Computer](https://planetarycomputer.microsoft.com/dataset/naip)) | **30 cm** RGB+NIR aerial photo; one tile covers the whole area | Cloud-optimized GeoTIFF, windowed reads | Public domain |
| NJ 2020 orthophotos ([maps.nj.gov](https://maps.nj.gov/arcgis/rest/services/Basemap/Orthos_Natural_2020_NJ_WM/MapServer)) | 1 ft RGB, as a fallback or cross-check | Cached tiles / WMTS | NJ public |
| **USGS 3DEP LiDAR** (in use): `NJ_SdL5_2014` (~8 pts/m² here); `NY_NewYorkCity` 2017 is sparse over JC (~2.4 pts/m²) | Terrain, roof levels, tree positions and heights. No building/vegetation classes, so those are derived | Entwine Point Tiles on S3 (`usgs-lidar-public`) | Public domain |
| Overture buildings (in use) | Footprints, heights (mostly USGS LiDAR) | GeoParquet via CLI | ODbL / CDLA |
| **Overture places** | Business names and categories (Meta/Microsoft-sourced), far denser than OSM | GeoParquet via CLI | CDLA-Permissive |
| **OpenStreetMap** (in use) | Streets, lanes, crossings, signals, stop signs, hydrants, benches, bus stops, Citi Bike docks, shop names, building colours | Overpass | ODbL |
| **Mapillary** (in use) | ~16.8k detected traffic signs and street objects with positions and facing direction (mostly 2018–2019 photos); street-level photos for facade colour reference | Graph API with a client token in `.env.local` | CC-BY-SA |
| ~~Google Street View~~ | Not usable: the terms forbid deriving content from it | n/a | n/a |

## Milestones

### M1: Buildings that match the records (done)
- Join each footprint to its tax parcel: real **storey count** drives the window rows, plus year
  built, material (brick vs frame), units and address.
- **Roof colour** sampled from the 30 cm NAIP photo inside each footprint.
- **Storefront signs** with real business names (OSM + Overture places) on the facade facing the street.
- **Inspector** (`I` key): look at a building to see its address, year, storeys, height and
  material, plus where each value came from and whether it's measured or estimated.

### M2: What's on the street (done)
- Street furniture at detected positions: street lights, utility poles, traffic and pedestrian
  signals, hydrants, trash cans, benches, cabinets, manholes, drains, bike racks (Mapillary),
  plus bus stops, shelters, Citi Bike docks and PATH entrances (OSM).
- ~2,800 traffic signs on shared posts, faces drawn to the US standard for each detected type,
  and street-name blades with the real street name.
- Stop lines, lane arrows and bike symbols where Mapillary saw them. Centre and lane lines from
  OSM `oneway`/`lanes`.
- Still open: curbs and real sidewalk widths, crosswalk styles (ladder vs. standard),
  signal mast arms, and refreshing old (2019) detections where newer photos exist.

### M3: LiDAR geometry (done)
- Terrain from ground returns (NJ 2014, ~8 pts/m²): a 3 m grid in metres above sea level, with
  everything draped or standing on it.
- ~4,500 measured trees (position, height, crown), checked against 2023 infrared imagery.
- Roof levels as extruded parts on ~220 buildings; embankment deck heights measured per block.
- Still open: trees planted after 2014, pitched roofs (gable/hip planes from LiDAR), water tanks
  as cylinders, merging the NYC 2017 survey where it's denser, and newer LiDAR when USGS publishes
  a post-2014 Hudson County survey.

### M4: Facade truth (done, first pass)
- Facade colours sampled from Mapillary photos via camera poses, with occlusion, angle and
  consensus checks. Measured on ~120 buildings, photo-guided on ~370.
- Era/type facade kits (rowhouse, frame, warehouse, mid-century, modern, glass) with storefront
  ground floors, cornices and inferred stoops. Bays come from lot frontage.
- Still open:
  - better colour coverage: leaf-on and summer photos, 1024 px thumbnails, per-facade colours
    for corner buildings;
  - bay windows and oriels (visible in LiDAR as facade bumps);
  - real door positions (address points / photos);
  - hand-modelled landmarks: Colgate Clock, Newport Centre, PATH headhouses, churches.

### M6: Focus areas with Mapillary 3D (in progress: `example-area`)
- Photo-match view and SfM point overlay for checking against reality.
- Done for `example-area`:
  - street level from LiDAR plus camera tracks;
  - the Coles Street cut between stone retaining walls, with the plateaus and lofts on top;
  - measured curbs.
- Done everywhere:
  - 2014 lot surfaces under today's buildings no longer spill onto streets;
  - street furniture snapping fixed: 967 objects were standing in roadways, now 37.
- Photo-textured facades: 25 walls, from registered reconstructions with a multi-photo vote
  per texel. Cleanup: sky and roofline per photo, masks for poles, signs, trunks, branches and
  glare, sign cut-outs, smooth hole filling. Walls the photos disagree on keep the kit.
- Next here:
  - registration with scale (the roofline stretch compensates for reconstructions that sit
    too close to the walls);
  - better facade sources: leaf-on and newer photos, or a phone walk-through capture of the
    block; parked cars along ground floors;
  - correct kits for converted lofts (the east loft renders as glass);
  - wall heights at the cut (ours read ~2 m taller than the photos);
  - per-object positions from SfM clusters;
  - then grow the area block by block.

### M5: Art direction
- Pick a rendering style and apply it consistently (materials, lighting, post-processing).
