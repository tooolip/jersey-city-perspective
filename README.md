# Jersey City Perspective

Explore a walkable 3D model of downtown Jersey City, built with Three.js and public geospatial data. The scene combines building footprints, measured terrain, street furniture, and a Manhattan skyline backdrop.

## Run locally

Requires a current Node.js version supported by Vite (20.19+ or 22.12+).

```sh
npm ci
npm run dev
```

Open [localhost:5173](http://localhost:5173), then click the scene to capture the mouse. The repository includes a prebuilt city dataset; you do not need to download the source data to explore it.

```sh
npm run build
npm run preview
```

## Controls

| Input | Action |
| --- | --- |
| W/A/S/D or arrow keys, mouse | Move and look |
| Shift | Run |
| F | Toggle flying |
| Space | Jump, or rise while flying |
| E / Q | Rise / descend while flying |
| M | Open the map; click to teleport |
| I | Inspect the building or street object under the cursor |
| 1–7 | Jump to a landmark |
| Escape | Release the mouse |

The walkable boundary covers downtown between the Turnpike, Christopher Columbus Drive, the Hudson River, and the Holland Tunnel area. A surrounding context ring extends the view.

## Data sources and attribution

| Source | Used for |
| --- | --- |
| [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors | Streets, water, parks, businesses, and other map features; ODbL |
| [Overture Maps](https://docs.overturemaps.org/attribution/) | Building footprints and places; retain the applicable source attribution |
| NJOGIS parcels and MOD-IV records | Building characteristics such as storeys, year, and construction; owner names are not downloaded |
| USDA NAIP imagery | Roof-color sampling and aerial reference |
| USGS 3DEP LiDAR | Terrain, trees, and roof levels |
| [Mapillary](https://www.mapillary.com/) | Street-object observations and facade imagery; CC BY-SA attribution applies |

These datasets have different survey dates. Older LiDAR and street photos can miss new buildings, changed trees, or current storefronts. Estimated heights and generated details are identified separately from measured data where available in the inspector. This is an experimental visualization, not a survey or navigation tool.

## Rebuild the city data

The viewer loads `public/data/city.json` and the terrain binary. To refresh them, create the Python environment used by the optional pipelines:

```sh
python3 -m venv .venv
.venv/bin/pip install overturemaps rasterio numpy scipy shapely pillow "laspy[lazrs]"
npm run fetch:osm
npm run fetch:overture
npm run build:data
```

Optional enrichment commands:

```sh
npm run fetch:parcels
npm run fetch:imagery
npm run fetch:mapillary
npm run fetch:lidar
npm run process:lidar
npm run build:data
npm run fetch:facades
npm run build:data
```

Some downloads are large. `fetch:mapillary` and the facade-photo pipeline need your own `MAPILLARY_TOKEN` in ignored `.env.local`. Raw downloads and derived intermediate data stay out of Git.

## Focus-area experiments

`scripts/focus/` contains an optional pipeline for refining a small area using Mapillary camera poses, point clouds, measured curbs, and photo-textured facades. Personal focus-area definitions and generated refinements are not distributed.

To define your own area, add a JSON file under `areas/` using `name`, `label`, `center` (latitude/longitude), `radius`, and `photoRadius` fields, then run `npm run focus -- YOUR_AREA_NAME`. Inspect the scripts for the exact pipeline parameters. P enters photo-match view, O changes overlay opacity, Shift+P selects the previous photo, K toggles the point cloud, and X exits photo mode. These controls require generated focus data and local photos.

## Project layout

- `src/`: renderer, scene builders, movement, inspector, and map.
- `scripts/`: source downloads and data processing.
- `scripts/lib/`: geometry, parcels, facade colors, street objects, and signs.
- `scripts/focus/`: optional high-detail reconstruction pipeline.
- `public/data/`: prebuilt viewer data.

See [ROADMAP.md](ROADMAP.md) for implementation notes and remaining work.
