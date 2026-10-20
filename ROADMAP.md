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
| **USGS 3DEP LiDAR**: `NY_NewYorkCity` (2017, **has RGB per point**) and `NJ_SdL5_2014` | Ground/terrain, roof shapes and setbacks, tree positions and canopy heights | Entwine Point Tiles on S3 (`usgs-lidar-public`) | Public domain |
| Overture buildings (in use) | Footprints, heights (mostly USGS LiDAR) | GeoParquet via CLI | ODbL / CDLA |
| **Overture places** | Business names and categories (Meta/Microsoft-sourced), far denser than OSM | GeoParquet via CLI | CDLA-Permissive |
| **OpenStreetMap** (in use) | Streets, lanes, crossings, signals, stop signs, hydrants, benches, bus stops, Citi Bike docks, shop names, building colours | Overpass | ODbL |
| **Mapillary** | Detected traffic signs and street objects with positions; street-level photos for facade colour reference | Graph API, needs a free access token | CC-BY-SA |
| ~~Google Street View~~ | Not usable: the terms forbid deriving content from it | n/a | n/a |

## Milestones

### M1: Buildings that match the records (done)
- Join each footprint to its tax parcel: real **storey count** drives the window rows, plus year
  built, material (brick vs frame), units and address.
- **Roof colour** sampled from the 30 cm NAIP photo inside each footprint.
- **Storefront signs** with real business names (OSM + Overture places) on the facade facing the street.
- **Inspector** (`I` key): look at a building to see its address, year, storeys, height and
  material, plus where each value came from and whether it's measured or estimated.

### M2: What's on the street
- Street furniture at mapped positions: traffic signals, stop signs, hydrants, benches, bus
  stops, Citi Bike docks, bollards, street-name signs at intersections.
- Lane markings from OSM `lanes`/`turn:lanes`/`oneway`, curbs and real sidewalk widths.
- Mapillary traffic-sign detections, which need the user's access token.

### M3: LiDAR geometry
- Terrain from ground-classified points (small grades, the Bergen Hill rise west of the Turnpike).
- Tree positions, heights and crown sizes from vegetation returns, replacing the procedural trees.
- Roof shapes, setbacks and rooftop structures (bulkheads, water tanks) from first returns.

### M4: Facade truth
- Facade colours from street-level imagery (Mapillary), sampled per building and flagged by confidence.
- Era-appropriate facade kits by year built and type: Italianate brownstone, brick rowhouse,
  converted warehouse, curtain-wall tower. Proportions come from lot frontage and storey heights.
- Hand-modelled landmarks: Colgate Clock, Newport Centre, PATH headhouses, churches.

### M5: Art direction
- Pick a rendering style and apply it consistently (materials, lighting, post-processing).
