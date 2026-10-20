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
python3 -m venv .venv && .venv/bin/pip install overturemaps rasterio numpy scipy shapely pillow "laspy[lazrs]"

npm run fetch:osm       # OpenStreetMap: streets, rail, parks, water, businesses, street furniture
npm run fetch:overture  # Overture buildings (+ Manhattan) and places
npm run fetch:parcels   # NJ tax parcels with MOD-IV records (no owner names)
npm run fetch:imagery   # USDA NAIP 2023 30 cm aerial photo (~250 MB)
npm run fetch:mapillary # Mapillary traffic signs + street objects (needs MAPILLARY_TOKEN)
npm run fetch:lidar     # USGS LiDAR point cloud, streamed into height grids (~36M points)
npm run process:lidar   # -> terrain, trees, roof levels in data/derived/
npm run build:data      # first pass (facade sampling reads the built scene)
npm run fetch:facades   # facade colours from Mapillary street photos -> data/derived/facades.json
npm run build:data      # -> public/data/city.json
```

Parcels, places, imagery, Mapillary and LiDAR are optional: the build skips any that are missing.
Without LiDAR the scene falls back to flat ground and generated trees.
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
- **Terrain, trees, roof levels:** USGS 3DEP LiDAR (NJ 2014 post-Sandy survey, ~8 points/m²,
  public domain).
  - *Terrain:* ground returns, gaps under buildings filled, exported as a 3 m grid in metres above
    NAVD88 (≈ sea level). Street level here is 1.5–4 m; Bergen Hill rises past 20 m west of the
    Turnpike. The river sits at 0.2 m, with bulkheads down to the bed.
  - *Trees (~4,500):* canopy is where the laser passed through foliage (multiple returns).
    Each tree is a local height peak with its real height, and its crown is sized from the canopy
    around it. Trees with no vegetation in the 2023 NAIP infrared photo are dropped (~1,800 gone
    since 2014). Trees planted after 2014 are still missing.
  - *Roof levels:* each footprint's height profile is split into levels, which become extruded
    parts: towers on podiums, setbacks, rear extensions, rooftop bulkheads (~220 buildings).
    74 buildings aren't in the 2014 scan (probably built since) and keep their Overture shape.
  - *Sixth Street Embankment:* deck height measured per block from the top surface: 3.0 m at the
    east end, rising to 7.9 m westward along the old rail grade.
- **Generated:** street trees only outside the LiDAR area. Generated lamps (~every 32 m) appear only
  where no real street light is within 35 m (~150 remain).

### Modeling notes

- Everything sits on the LiDAR terrain. Ground layers (land, parks, roads, sidewalks, markings,
  rails) are subdivided and draped over it. Buildings stand on the lowest ground point of their
  footprint. Land is the world minus the OSM water polygons, so shorelines are exact.
- Elevated roads (OSM `bridge`/`layer`) are raised 6.5 m per layer, with pillars, and ramp down
  where they meet ground-level streets. Tunnels are skipped.
- The Sixth Street (Harsimus Stem) Embankment is raised into 7.5 m stone blocks with trees on top.
- **Facade kits** by era and type, from tax records:
  - rowhouse: masonry before 1940;
  - frame: wood frame with siding;
  - warehouse: industrial, or large masonry before 1940;
  - mid-century: 1940–89 and 4+ storeys;
  - modern: 1990 or later;
  - glass: towers.

  Each kit has its own ground-floor and upper-floor storey design, from one atlas (`src/facade-atlas.js`).
  - Window rows follow the recorded storey count. Rowhouse window bays come from the recorded lot
    frontage: a 20 ft lot gets 3 bays.
  - Buildings with businesses or commercial use get a storefront ground floor.
  - Pre-1940 street facades get a cornice.
  - Stoops: pre-1910 brick rowhouses get one to the parlour floor, at the door bay. Stoops are
    *inferred* from era and type. The door side alternates by lot number, which produces the
    mirrored pairs common here, but it's not observed.
- **Facade colours** come from Mapillary street photos (`scripts/fetch-facade-colours.py`):
  - *Method:* each street-facing facade is projected into the photos that face it, using the
    photo's computed camera pose. Points on the 2nd–3rd floors are sampled, skipping sightlines
    blocked by buildings or tree crowns, grazing views, busy patches (branches, signs) and
    sky/glass pixels. Each photo's exposure is normalised against the road, and the wall's
    dominant colour is taken.
  - *Use:* when 2+ photos agree (~120 buildings) the colour is used as measured. A single photo
    (~370) only picks the closest shade in the material palette. Photos that disagree are ignored.
  - *Caveat:* most photos are leaf-off winter captures from 2019, so coverage is partial and
    colours carry overcast lighting.
- Otherwise the facade palette follows the recorded construction and era: brick or brownstone,
  frame siding, concrete.

## Focus areas (Mapillary 3D refinement)

Small areas get refined one at a time using Mapillary's 3D data: each photo's computed camera
pose and the structure-from-motion point clouds built from the photos. An area is a file in
`areas/` (centre and radius). The first one is `example-area`, a 70 m radius around [redacted address]

```bash
npm run focus -- example-area
```

This runs `scripts/focus/`:

- `fetch-3d.py`: photos within 140 m (2048 px), their poses and SfM reconstructions.
- `build-focus.py`: aligns each reconstruction vertically, since phone GPS altitude is off by
  ±5 m, so cameras sit 1.5 m above the LiDAR ground. Writes photo poses and the SfM points for
  the viewer.
- `terrain.py`:
  - *Street level:* interpolated from LiDAR ground along road centrelines plus the 2019 camera
    tracks.
  - *Plateaus:* ground more than 2 m above street level becomes a solid block with
    rubble-stone retaining walls and the measured top, including buildings that stand on it.
  - *Cuts:* OSM "tunnels" through a plateau (the photos show open cuts, e.g. Coles Street)
    become a corridor between the measured walls, with the roadway recentred between them.
    The OSM centreline was about 5 m off there.
- `streets.py`: curbs from LiDAR cross-profiles averaged along each street (the 10–20 cm
  step), giving per-side road widths. Checked against the aerial photo in `curbs.jpg`.
- `register.py`: shifts and rotates each reconstruction so its facade points land on the
  building walls (point-to-wall ICP after a coarse search). It's conservative because walls
  don't constrain sliding along a street: 19 of 29 reconstructions were corrected, by up to
  ~8 m, and the rest are kept as-is.
- `facades.py`: photo-textures walls.
  - Each 4 cm texel is projected into up to 6 photos (at most 2 per drive-through) with the
    registered poses. Lines of sight blocked by other buildings and sky pixels are skipped.
  - Photos are matched in exposure, then combined per texel: the sample that agrees best with
    the others wins. Parallax between drives suppresses cars and partly the street trees.
  - Walls are lifted to normal exposure and packed into an atlas (`facades-0.jpg`). The
    viewer textures those walls instead of the kit.
  - About 30 walls so far.

In the viewer:
- `P`: jump to the nearest real photo's exact pose and overlay it (`O` opacity, `⇧P` previous,
  `X` exit). This is the main way to check the model against reality.
- `K`: show the SfM point cloud.

Photo-facade limits: the photos here are December 2019 phone captures, mostly backlit and
leaf-off. Bare street-tree branches, signs and some parked cars get baked into the walls, and
roofline edges pick up a ragged band of branches against sky. Buildings finished after 2019
show their construction stage.

Lessons so far:
- Mapillary's absolute positions carry a few metres of GPS bias, so geometry comes from
  LiDAR and the aerial photo, and Mapillary supplies appearance and relative layout.
- OSM centrelines and default widths can be metres off; the focus pipeline measures them.

## Code layout

```
scripts/fetch-osm.mjs       Overpass downloads (with retries / mirrors)
scripts/fetch-overture.sh   Overture building downloads
scripts/fetch-parcels.mjs   NJ parcels + MOD-IV download
scripts/fetch-imagery.py    NAIP aerial photo download (windowed read, reprojected)
scripts/fetch-mapillary.mjs Mapillary map features download (tiled)
scripts/fetch-lidar.py      LiDAR (Entwine Point Tiles) streamed into ground/surface grids
scripts/process-lidar.py    Terrain, tree detection (+ NDVI check), roof-level parts
scripts/fetch-facade-colours.py  Facade colours sampled from Mapillary photos
scripts/build-data.mjs      Projection, boundary, clipping, land/water, generated trees & lamps
scripts/lib/                Parcel join, roof colours, storefront signs, street furniture, geometry
src/main.js                 Renderer, sky/sun/shadows, HUD, landmarks, main loop
src/world.js                Builds the scene from city.json; collision & street-name queries
src/builders.js             Mesh builders: buildings, ground areas, roads, rails, water, seawall
src/terrain.js              Terrain height sampling and draping of ground layers
src/props.js                Instanced trees (LiDAR-measured and generated) and street lamps
src/signs.js                Storefront signs (text atlases, brand colours)
src/facade-atlas.js         Facade kit atlas + shader (per-storey rows, wall tint mask)
src/furniture.js            Street furniture models, traffic-sign faces, road decals
src/inspector.js            Building / street-object inspector panel
src/textures.js             Procedural facade textures
src/player.js               First-person controller (pointer lock, walk/run/jump/fly, sliding collision)
src/minimap.js              Corner minimap and full-screen teleport map
src/focus.js                Focus areas: photo-match view, SfM point overlay
scripts/focus/              Focus-area pipeline (Mapillary 3D, terrain, curbs)
areas/                      Focus-area definitions
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
