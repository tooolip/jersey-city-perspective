# Jersey City Walk

A first-person, walkable 3D model of downtown Jersey City built with Three.js.

**Project area:** NJ Turnpike (Newark Bay Extension) to the west, Christopher Columbus Drive
to the south, the Hudson River to the east, and 12th Street / the Holland Tunnel entrance to
the north. A ~260 m ring of context outside that area is also rendered, plus the Lower and
Midtown-south Manhattan skyline across the river. You can only walk inside the project area
(with a small margin so the boundary streets themselves are walkable).

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:5173 and click to start.

| Key | Action |
| --- | --- |
| `W A S D` / arrows, mouse | Move / look |
| `Shift` | Run |
| `Space` | Jump (in fly mode: up) |
| `F` | Toggle fly mode, then `E` / `Q` to go up / down |
| `M` | Full map; click anywhere on it to teleport |
| `I` | Inspector: aim at a building or street object to see what the records say about it (address, year built, storeys, height, construction, roof colour, businesses; or sign type and when it was last photographed), with the source of each value |
| `1`–`7` | Jump to a landmark (Exchange Place, Newport, Hamilton Park, Grove St PATH, Holland Tunnel, Sixth St Embankment, Newport Centre) |
| `Esc` | Release the mouse |

## Data pipeline

The browser loads one pre-built file, `public/data/city.json`, with everything in local meters
(`[east, north]` from an origin at 40.724, -74.042). To rebuild it from fresh downloads:

```bash
# One-time Python setup (Overture CLI + raster tools)
python3 -m venv .venv && .venv/bin/pip install overturemaps rasterio numpy

npm run fetch:osm       # OpenStreetMap: streets, rail, parks, water, businesses, street furniture
npm run fetch:overture  # Overture buildings (+ Manhattan) and places
npm run fetch:parcels   # NJ tax parcels with MOD-IV records (no owner names)
npm run fetch:imagery   # USDA NAIP 2023 30 cm aerial photo (~250 MB)
npm run fetch:mapillary # Mapillary traffic signs + street objects (needs MAPILLARY_TOKEN)
npm run build:data      # -> public/data/city.json
```

Parcels, places, imagery and Mapillary are optional: the build skips any that are missing.
For Mapillary, put a client token from mapillary.com/dashboard/developers in `.env.local`
(git-ignored) as `MAPILLARY_TOKEN=MLY|...`, or set it in the environment.

Raw downloads go in `data/raw/` (git-ignored).

### Sources

- **Building footprints and heights:** [Overture Maps Foundation](https://overturemaps.org/)
  buildings. Footprints come from OpenStreetMap. Heights mostly come from **USGS 3DEP LiDAR**
  (~3,000 buildings), and the rest from Microsoft ML Buildings. About 20% of the buildings in the
  area (615) have no measured height and get an estimate (rowhouse ≈ 11 m, larger footprint ≈ 14 m).
- **Storeys, year built, construction, use, address:** NJ Parcels + MOD-IV tax records (NJOGIS).
  These are joined to footprints by area vote. Material is inferred from the assessor's shorthand,
  e.g. `3S-B-D-2U` means 3 storeys, brick, 2 units. Owner names are not downloaded.
- **Roof colours:** median colour inside each footprint (inset 0.6 m, ignoring tree canopy and deep
  shadow), sampled from the USDA NAIP 2023 30 cm aerial photo (public domain).
- **Storefront signs:** real business names from OSM (preferred) and Overture places (open,
  high-confidence, street-facing categories only), mounted on the facade facing the street. Known
  chains use their brand colours; the rest use generic colours by kind.
- **Street furniture and traffic signs:** [Mapillary](https://www.mapillary.com) map features
  (CC-BY-SA). These are objects detected in street-level photos and triangulated, mostly last
  photographed in 2018–2019, some in 2026. Included: street lights, utility poles, traffic and
  pedestrian signals, hydrants, trash cans, benches, cabinets, manholes, drains, stop lines, lane
  arrows and ~2,800 classified traffic signs on shared posts. Positions are good to a few metres
  and are snapped out of buildings and carriageways. Traffic cones and temporary barriers are
  dropped. Sign faces are drawn to the standard US (MUTCD) design for the detected type. Green
  "general directions" detections are rendered as street-name blades showing the OSM street name.
- **Bus stops, Citi Bike docks, PATH entrances:** OSM, used where Mapillary has nothing within 10 m.
- **Lane markings:** from OSM `oneway`/`lanes`. Double yellow centre lines on two-way main streets,
  dashed white lines between same-direction lanes, clear of intersections.
- **Everything else:** © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors,
  ODbL, via the Overpass API.
- **Generated:** OSM maps only ~120 trees here, so street trees (every ~8 m along sidewalks) and
  park/wood trees are placed procedurally with a fixed seed. Generated lamps (~every 32 m) now
  appear only where no real street light is within 35 m (~150 remain).

### Modeling notes

- The ground is flat at street level. Downtown JC sits only a few meters above the river, so
  terrain is left for later.
- The river is a plane 1.6 m below the street, with a bulkhead wall wherever land meets water.
  Land is computed as the world minus the OSM water polygons.
- Elevated roads (OSM `bridge`/`layer`) are raised 6.5 m per layer, with pillars, and ramp down
  where they meet ground-level streets. Tunnels are skipped.
- The Sixth Street (Harsimus Stem) Embankment is raised into 7.5 m stone blocks with trees on top.
- Window rows follow the recorded storey count when it agrees with the measured height.
  Measured buildings here average 3.9 m per storey, so storey-only estimates use 3.75 m plus a parapet.
- Facade palettes follow the recorded construction and era: brick or brownstone, frame siding,
  concrete. Buildings 40 m and taller, or post-2000 and 25 m and taller, get curtain-wall glass.
  Exact facade colours aren't in any dataset yet (see [ROADMAP.md](ROADMAP.md)).

## Code layout

```
scripts/fetch-osm.mjs       Overpass downloads (with retries / mirrors)
scripts/fetch-overture.sh   Overture building downloads
scripts/fetch-parcels.mjs   NJ parcels + MOD-IV download
scripts/fetch-imagery.py    NAIP aerial photo download (windowed read, reprojected)
scripts/fetch-mapillary.mjs Mapillary map features download (tiled)
scripts/build-data.mjs      Projection, boundary, clipping, land/water, generated trees & lamps
scripts/lib/                Parcel join, roof colours, storefront signs, street furniture, geometry
src/main.js                 Renderer, sky/sun/shadows, HUD, landmarks, main loop
src/world.js                Builds the scene from city.json; collision & street-name queries
src/builders.js             Mesh builders: buildings, ground areas, roads, rails, water, seawall
src/props.js                Instanced trees and street lamps
src/signs.js                Storefront signs (text atlases, brand colours) and glazing
src/furniture.js            Street furniture models, traffic-sign faces, road decals
src/inspector.js            Building / street-object inspector panel
src/textures.js             Procedural facade textures
src/player.js               First-person controller (pointer lock, walk/run/jump/fly, sliding collision)
src/minimap.js              Corner minimap and full-screen teleport map
```

## Next steps

See [ROADMAP.md](ROADMAP.md) for the data-driven plan. Older ideas:

- **Art direction:** pick a target style (photoreal vs. stylized/low-poly) and redo materials to match.
- **Facades:** storefronts on commercial streets (Newark Ave, Grove St, Washington Blvd), stoops
  and cornices on brownstones, real roof shapes, landmark models (Colgate Clock, Newport towers).
- **Streets:** lane markings, curbs, traffic lights (positions already in the data as `signals`),
  parked cars, benches, PATH entrances, the Hudson-Bergen Light Rail stations.
- **Terrain:** USGS 3DEP DEM for the gentle grades and the Bergen Hill rise west of the Turnpike.
- **Hoboken & Liberty State Park:** extend the context ring north and south for the waterfront views.
- **Lighting:** time-of-day slider with lit windows and street lamps at night.
- **Performance:** split buildings into chunks for frustum culling, and add LOD for the skyline.
