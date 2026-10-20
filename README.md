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
| `1`–`7` | Jump to a landmark (Exchange Place, Newport, Hamilton Park, Grove St PATH, Holland Tunnel, Sixth St Embankment, Newport Centre) |
| `Esc` | Release the mouse |

## Data pipeline

The browser loads one pre-built file, `public/data/city.json`, with everything in local meters
(`[east, north]` from an origin at 40.724, -74.042). To rebuild it from fresh downloads:

```bash
# 1. OpenStreetMap: streets, sidewalks, rail, parks, water, piers, trees, lamps
npm run fetch:osm

# 2. Overture Maps buildings (needs the Python CLI once:
#    python3 -m venv .venv && .venv/bin/pip install overturemaps)
npm run fetch:overture

# 3. Convert to public/data/city.json
npm run build:data
```

Raw downloads go in `data/raw/` (git-ignored).

### Sources

- **Building footprints and heights:** [Overture Maps Foundation](https://overturemaps.org/)
  buildings. Footprints come from OpenStreetMap. Heights mostly come from **USGS 3DEP LiDAR**
  (~3,000 buildings), and the rest from Microsoft ML Buildings. About 20% of the buildings in the
  area (615) have no measured height and get an estimate (rowhouse ≈ 11 m, larger footprint ≈ 14 m).
- **Everything else:** © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors,
  ODbL, via the Overpass API.
- **Generated:** OSM maps only ~120 trees and ~70 lamps here, so street trees (every ~8 m along
  sidewalks), park/wood trees, and lamps (~every 32 m) are placed procedurally with a fixed seed.

### Modeling notes

- The ground is flat at street level. Downtown JC sits only a few meters above the river, so
  terrain is left for later.
- The river is a plane 1.6 m below the street, with a bulkhead wall wherever land meets water.
  Land is computed as the world minus the OSM water polygons.
- Elevated roads (OSM `bridge`/`layer`) are raised 6.5 m per layer, with pillars, and ramp down
  where they meet ground-level streets. Tunnels are skipped.
- The Sixth Street (Harsimus Stem) Embankment is raised into 7.5 m stone blocks with trees on top.
- Facade textures are generated in code: punched windows for masonry, curtain-wall glass for
  buildings 40 m and taller. Each building is tinted from brick / painted / glass palettes.

## Code layout

```
scripts/fetch-osm.mjs       Overpass downloads (with retries / mirrors)
scripts/fetch-overture.sh   Overture building downloads
scripts/build-data.mjs      Projection, boundary, clipping, land/water, generated trees & lamps
src/main.js                 Renderer, sky/sun/shadows, HUD, landmarks, main loop
src/world.js                Builds the scene from city.json; collision & street-name queries
src/builders.js             Mesh builders: buildings, ground areas, roads, rails, water, seawall
src/props.js                Instanced trees and street lamps
src/textures.js             Procedural facade textures
src/player.js               First-person controller (pointer lock, walk/run/jump/fly, sliding collision)
src/minimap.js              Corner minimap and full-screen teleport map
```

## Ideas for the next passes

- **Art direction:** pick a target style (photoreal vs. stylized/low-poly) and redo materials to match.
- **Facades:** storefronts on commercial streets (Newark Ave, Grove St, Washington Blvd), stoops
  and cornices on brownstones, real roof shapes, landmark models (Colgate Clock, Newport towers).
- **Streets:** lane markings, curbs, traffic lights (positions already in the data as `signals`),
  parked cars, benches, PATH entrances, the Hudson-Bergen Light Rail stations.
- **Terrain:** USGS 3DEP DEM for the gentle grades and the Bergen Hill rise west of the Turnpike.
- **Hoboken & Liberty State Park:** extend the context ring north and south for the waterfront views.
- **Lighting:** time-of-day slider with lit windows and street lamps at night.
- **Performance:** split buildings into chunks for frustum culling, and add LOD for the skyline.
