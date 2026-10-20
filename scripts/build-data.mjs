// Converts raw OSM + Overture downloads into public/data/city.json, a compact
// scene description in local meters. Coordinates are [east, north] relative to ORIGIN.
// Usage: node scripts/build-data.mjs
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import polygonClipping from 'polygon-clipping';
import { loadParcels, joinBuildingsToParcels } from './lib/parcels.mjs';
import { loadImagery, sampleRoofColours } from './lib/roof-colours.mjs';
import { collectBusinesses, placeSigns } from './lib/signs.mjs';
import { buildStreetFurniture } from './lib/street.mjs';
import { loadLidar, buildTerrain } from './lib/lidar.mjs';
import { annotateFacades } from './lib/facades.mjs';
import { segIntersect, pointInRing, distToSeg, distToRing, toPts, bbox, centroid, ringArea, openRing, assembleRings, Grid } from './lib/geom.mjs';

const ORIGIN = { lat: 40.724, lon: -74.042 };
const M_PER_DEG_LAT = 111132.954 - 559.822 * Math.cos(2 * ORIGIN.lat * Math.PI / 180);
const M_PER_DEG_LON = 111412.84 * Math.cos(ORIGIN.lat * Math.PI / 180);

const proj = (lon, lat) => [
  Math.round((lon - ORIGIN.lon) * M_PER_DEG_LON * 10) / 10,
  Math.round((lat - ORIGIN.lat) * M_PER_DEG_LAT * 10) / 10,
];
const projLL = (p) => proj(p.lon, p.lat);
const unproj = (e, n) => [ORIGIN.lon + e / M_PER_DEG_LON, ORIGIN.lat + n / M_PER_DEG_LAT];

// How far outside the walkable boundary we still render detail (context ring).
const CONTEXT_M = 260;
// Clip rectangle for water (covers the Manhattan backdrop and the Upper Bay).
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const CLIP = rect(-4000, -7000, 7000, 5000);
// Land extends to the horizon; water polygons are cut out of it.
const LAND_RECT = rect(-30000, -30000, 30000, 30000);

const readJSON = async (p) => JSON.parse(await readFile(p, 'utf8'));
const osm = (await readJSON('data/raw/osm_features.json')).elements;
const osmRel = (await readJSON('data/raw/osm_relations.json')).elements;
const boundaryRoads = (await readJSON('data/raw/boundary_roads.json')).elements;
const ovJC = (await readJSON('data/raw/overture_buildings_jc.geojson')).features;
const ovMH = (await readJSON('data/raw/overture_buildings_manhattan.geojson')).features;
// Optional enrichment sources (the build still works without them).
const optional = async (p) => { try { return await readJSON(p); } catch { console.warn(`(missing ${p})`); return null; } };
const parcelsRaw = await optional('data/raw/parcels.geojson');
const osmPois = (await optional('data/raw/osm_pois.json'))?.elements || [];
const places = (await optional('data/raw/overture_places.geojson'))?.features || [];
const imagery = await loadImagery();
// Focus areas (areas/*.json) refined with Mapillary 3D data: terrain patches, plateaus, cuts.
const focusAreas = [];
for (const f of (await readdir('areas').catch(() => [])).filter((x) => x.endsWith('.json'))) {
  const area = await readJSON(`areas/${f}`);
  const terrainPatch = await optional(`data/derived/focus/${area.name}/terrain.json`);
  const streets = await optional(`data/derived/focus/${area.name}/streets.json`);
  focusAreas.push({ ...area, terrain: terrainPatch, streets });
}
const mapillary = (await optional('data/raw/mapillary_features.json')) || [];
const lidar = await loadLidar();
const photoColours = (await optional('data/derived/facades.json')) || {};
if (!lidar) console.warn('(missing data/derived LiDAR products; run scripts/fetch-lidar.py + process-lidar.py)');
if (!imagery) console.warn('(missing data/raw/naip.rgb; run scripts/fetch-imagery.py)');

// ---------------------------------------------------------------- boundary
// West: NJ Turnpike Newark Bay Extension. North: 12th Street up to the Holland Tunnel
// entrance, then due east to the river. South: Christopher Columbus Drive. East: Hudson.
const byId = new Map(boundaryRoads.map((e) => [e.id, e]));
const chain = (ids) => {
  const pts = [];
  for (const id of ids) for (const g of byId.get(id).geometry) {
    const p = projLL(g);
    const q = pts[pts.length - 1];
    if (!q || q[0] !== p[0] || q[1] !== p[1]) pts.push(p);
  }
  return pts;
};
const turnpike = chain([256899604, 26784999, 26785001]); // northbound, SW -> NE
const twelfth = chain([415843097, 641774356, 1488598252, 798233818]); // W -> E to tunnel portal
const columbusPts = boundaryRoads
  .filter((e) => e.tags.name === 'Christopher Columbus Drive')
  .flatMap((e) => e.geometry.map(projLL))
  .sort((a, b) => a[0] - b[0]); // W -> E (the drive runs roughly east-west)
// Thin the dual-carriageway zigzag: keep one point per 15 m of easting.
const columbus = [];
for (const p of columbusPts) if (!columbus.length || p[0] - columbus[columbus.length - 1][0] > 15) columbus.push(p);
columbus.push(columbusPts[columbusPts.length - 1]);

// Where Columbus Drive passes under the turnpike.
let cut = null;
for (let i = 0; i < turnpike.length - 1 && !cut; i++)
  for (let j = 0; j < columbus.length - 1 && !cut; j++) {
    const hit = segIntersect(turnpike[i], turnpike[i + 1], columbus[j], columbus[j + 1]);
    if (hit) cut = { i, j, p: hit.p };
  }
if (!cut) throw new Error('Turnpike / Columbus Drive intersection not found');

const RIVER_X = proj(-74.022, ORIGIN.lat)[0];
const portal = twelfth[twelfth.length - 1];
const columbusEast = columbus[columbus.length - 1];
const boundary = [
  cut.p,
  ...turnpike.slice(cut.i + 1),
  ...twelfth.slice(1),
  [RIVER_X, portal[1]],
  [RIVER_X, columbusEast[1]],
  ...columbus.slice(cut.j + 1).reverse(),
].map((p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]);
const boundaryClosed = [...boundary, boundary[0]];

const inScope = (p, margin = CONTEXT_M) => pointInRing(p, boundary) || distToRing(p, boundaryClosed) < margin;
const lineInScope = (pts, margin) => pts.some((p) => inScope(p, margin));

// ---------------------------------------------------------------- buildings
function heightOf(props, footprintArea) {
  if (props.height) return props.height;
  if (props.num_floors) return props.num_floors * 3.3 + 1;
  const cls = props.class || props.subtype;
  if (['shed', 'garage', 'garages', 'carport', 'roof', 'kiosk'].includes(cls)) return 3;
  if (cls === 'house') return 9;
  // Downtown JC fabric is mostly 3-4 storey rowhouses / brownstones.
  return footprintArea < 400 ? 11 : 14;
}

function convertBuildings(features, filter) {
  const out = [];
  for (const f of features) {
    const pr = f.properties;
    if (pr.is_underground) continue;
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) {
      const rings = poly.map((r) => openRing(r.map(([lon, lat]) => proj(lon, lat))));
      const outer = rings[0];
      if (outer.length < 3) continue;
      const c = centroid(outer);
      if (filter && !filter(c)) continue;
      const area = Math.abs(ringArea(outer));
      if (area < 6) continue;
      const cls = pr.class || pr.subtype;
      const b = { o: outer.flat(), h: Math.round(heightOf(pr, area) * 10) / 10, _id: pr.id };
      if (rings.length > 1) b.holes = rings.slice(1).filter((r) => r.length >= 3).map((r) => r.flat());
      if (pr.min_height) b.mh = pr.min_height;
      // Free-standing roofs (gas-station / toll canopies) are slabs you can walk under.
      else if (cls === 'roof' || cls === 'carport') { b.h = Math.max(b.h, 4); b.mh = b.h - 0.6; }
      if (cls) b.c = cls;
      if (pr.facade_color) b.fc = pr.facade_color;
      if (pr.roof_shape && pr.roof_shape !== 'flat') b.rs = pr.roof_shape;
      const name = pr.names?.primary;
      if (name) b.n = name;
      if (!pr.height && !pr.num_floors) b.est = 1; // height is a guess
      out.push(b);
    }
  }
  return out;
}

const buildings = convertBuildings(ovJC, (c) => inScope(c));
// Manhattan backdrop: everything east of the river in the download.
const skyline = convertBuildings(ovMH, (c) => c[0] > 1200);

// Tax records (storeys, year built, construction, address) and roof colours from the aerial photo.
const parcelStats = parcelsRaw ? joinBuildingsToParcels(buildings, loadParcels(parcelsRaw, proj)) : 0;
const roofStats = imagery ? sampleRoofColours(buildings, imagery, unproj) : 0;

// LiDAR roof levels: towers on podiums, setbacks, rear extensions, rooftop bulkheads.
let lidarRoofs = 0, lidarAbsent = 0;
if (lidar) {
  for (const b of buildings) {
    const r = lidar.roofs.roofs[b._id];
    if (!r) continue;
    if (r.absent) {
      // Not there in 2014: keep Overture's shape, but trust the recorded storeys over a height
      // that would make them implausibly short (e.g. [redacted address]: 7 storeys at 15.8 m).
      b.lid = 'absent';
      lidarAbsent++;
      const st = b.tax?.storeys;
      if (st && b.h / st < 2.6) { b.h = Math.round((st * 3.4 + 1) * 10) / 10; b.est = 'storeys'; }
      continue;
    }
    b.lid = 1;
    if (r.zb !== undefined) b.zb = r.zb; // ground elevation the LiDAR heights are measured from
    if (r.parts?.length) {
      b.parts = r.parts;
      b.h = Math.max(r.base, 2.5);
      if (b.est) b.est = undefined;
      lidarRoofs++;
    } else if (b.est && r.base >= 2.5) {
      b.h = r.base;
      b.est = undefined;
    }
  }
}

// ---------------------------------------------------------------- roads & rail
const ROAD_WIDTH = {
  motorway: 11, trunk: 11, primary: 13, secondary: 12, tertiary: 10, residential: 8,
  unclassified: 7, living_street: 6, service: 4.5, pedestrian: 6,
  motorway_link: 6, trunk_link: 6, primary_link: 6, secondary_link: 6, tertiary_link: 6,
  footway: 2.2, cycleway: 2, path: 1.6, steps: 2.2, track: 3,
};
const FOOT = new Set(['footway', 'cycleway', 'path', 'steps', 'pedestrian', 'track']);

function elevationOf(t) {
  const layer = parseInt(t.layer || '0', 10) || 0;
  if ((t.bridge && t.bridge !== 'no') || layer > 0) return Math.max(layer, 1) * 6.5;
  return 0;
}

const roads = [];
const paths = [];
const rails = [];
const areas = [];
const trees = [];
const embLines = []; // Sixth Street (Harsimus Stem) Embankment centreline
const lamps = [];
const signals = [];

const AREA_KIND = (t) => {
  if (t.natural === 'water' || t.water || t.amenity === 'fountain') return 'water';
  if (t.man_made === 'pier' || t.man_made === 'breakwater') return 'pier';
  if (t.man_made === 'bridge') return null;
  if (t.leisure === 'pitch' || t.leisure === 'track') return 'pitch';
  if (t.leisure === 'playground') return 'playground';
  if (t.leisure === 'marina') return null;
  if (['park', 'garden', 'dog_park'].includes(t.leisure)) return 'park';
  if (['grass', 'recreation_ground', 'flowerbed', 'greenfield', 'cemetery', 'allotments', 'village_green'].includes(t.landuse)) return 'grass';
  if (t.natural === 'grassland') return 'grass';
  if (t.natural === 'wood' || t.natural === 'scrub' || t.landuse === 'forest') return 'wood';
  if (t.natural === 'sand' || t.natural === 'beach') return 'sand';
  if (t.amenity === 'parking') return 'parking';
  if (['construction', 'brownfield'].includes(t.landuse)) return 'dirt';
  if (t.railway === 'platform') return 'platform';
  if (t.highway === 'pedestrian' && t.area === 'yes') return 'plaza';
  return null;
};

for (const e of osm) {
  const t = e.tags || {};
  if (e.type === 'node') {
    const p = proj(e.lon, e.lat);
    if (!inScope(p)) continue;
    if (t.natural === 'tree') trees.push(...p);
    // OSM street lamps come in through osm_pois as street furniture.
    else if (t.highway === 'traffic_signals') signals.push(...p);
    continue;
  }
  if (e.type !== 'way' || !e.geometry) continue;
  const pts = e.geometry.map(projLL);
  const closed = pts.length > 3 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];

  // Areas
  const kind = AREA_KIND(t);
  const isAreaHighway = t.highway && (t.area === 'yes' || (t.highway === 'pedestrian' && closed && t.area !== 'no'));
  if (kind && closed && (!t.highway || isAreaHighway)) {
    const ring = openRing(pts);
    if (kind === 'water') {
      // Water is handled with relations below if large; small ponds/fountains here.
      if (!lineInScope(ring, CONTEXT_M)) continue;
    } else if (!lineInScope(ring, CONTEXT_M)) continue;
    areas.push({ k: kind === 'water' ? 'water' : (isAreaHighway ? 'plaza' : kind), o: ring.flat() });
    continue;
  }

  if (t.highway && ROAD_WIDTH[t.highway] && !isAreaHighway) {
    if (t.tunnel && t.tunnel !== 'no') continue;
    if (t.indoor === 'yes' || t.level?.startsWith('-')) continue;
    if (!lineInScope(pts, CONTEXT_M)) continue;
    let w = ROAD_WIDTH[t.highway];
    if (t.width && !isNaN(parseFloat(t.width))) w = parseFloat(t.width);
    else if (t.lanes && !FOOT.has(t.highway)) w = Math.max(w * 0.6, parseInt(t.lanes, 10) * 3.4 + (t.oneway === 'yes' ? 1 : 2));
    const r = { k: t.highway, w: Math.round(w * 10) / 10, p: pts.flat() };
    const el = elevationOf(t);
    if (el) r.e = el;
    if (t.name) r.n = t.name;
    if (t.oneway === 'yes' || t.oneway === '1' || t.junction === 'roundabout') r.ow = 1;
    else if (t.oneway === '-1') r.ow = -1;
    if (t.lanes && parseInt(t.lanes, 10)) r.ln = parseInt(t.lanes, 10);
    if (t.footway) r.f = t.footway; // sidewalk / crossing
    (FOOT.has(t.highway) ? paths : roads).push(r);
    continue;
  }

  if (t.railway === 'razed' && t.embankment === 'yes') embLines.push(pts);

  if (t.railway === 'light_rail' || t.railway === 'rail' || t.railway === 'tram') {
    if (t.tunnel && t.tunnel !== 'no') continue;
    if (!lineInScope(pts, CONTEXT_M)) continue;
    const r = { k: t.railway, p: pts.flat() };
    const el = elevationOf(t);
    if (el) r.e = el;
    rails.push(r);
  }
}

// ---------------------------------------------------------------- water & park relations
const clipPoly = [CLIP];
const water = [];
for (const rel of osmRel) {
  const t = rel.tags || {};
  const isWater = t.natural === 'water' || t.water;
  const isPark = t.leisure === 'park';
  if (!isWater && !isPark) continue;
  const outers = assembleRings(rel.members.filter((m) => m.type === 'way' && m.role !== 'inner' && m.geometry).map((m) => m.geometry.map(projLL)));
  const inners = assembleRings(rel.members.filter((m) => m.type === 'way' && m.role === 'inner' && m.geometry).map((m) => m.geometry.map(projLL)));
  if (!outers.length) continue;
  let geom;
  try {
    geom = polygonClipping.difference(outers.map((r) => [r]), ...inners.map((r) => [[r]]));
    geom = polygonClipping.intersection(geom, clipPoly);
  } catch (err) {
    console.warn(`Skipping relation ${rel.id}: ${err.message}`);
    continue;
  }
  for (const poly of geom) {
    const rings = poly.map((r) => openRing(r.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10])));
    if (rings[0].length < 3) continue;
    const a = { k: isWater ? 'water' : 'park', o: rings[0].flat() };
    if (rings.length > 1) a.holes = rings.slice(1).map((r) => r.flat());
    if (isPark && !lineInScope(rings[0], CONTEXT_M)) continue;
    (isWater ? water : areas).push(a);
  }
}

// Land = everything minus the water, so the river can sit below a bulkhead edge.
const waterGeom = water.map((w) => [w.o, ...(w.holes || [])].map((flat) => {
  const r = [];
  for (let i = 0; i < flat.length; i += 2) r.push([flat[i], flat[i + 1]]);
  r.push(r[0]);
  return r;
}));
let land = polygonClipping.difference([LAND_RECT], ...waterGeom.map((g) => [g])).map((poly) => {
  const rings = poly.map((r) => openRing(r).flat());
  return rings.length > 1 ? { o: rings[0], holes: rings.slice(1) } : { o: rings[0] };
});

// ---------------------------------------------------------------- Sixth Street Embankment
// The 1901 PRR stone embankment stands ~7.5 m above the street. OSM maps its overgrown top as
// wood/grass areas along the old rail centreline; raise those into a solid stone block.
const EMB_HEIGHT = 7.5;
const nearEmbankment = (p) => embLines.some((line) => line.some((q, i) => i && distToSeg(p, line[i - 1], q) < 18));
for (const a of areas) {
  if (['wood', 'grass', 'park'].includes(a.k) && nearEmbankment(centroid(toPts(a.o)))) a.emb = EMB_HEIGHT;
}

// ---------------------------------------------------------------- generated street furniture
// OSM only has a handful of mapped trees and lamps; downtown JC streets are tree-lined,
// so plant trees along sidewalks and in parks, avoiding buildings and carriageways.
let seed = 1234567;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const bGrid = new Grid(40);
for (const b of buildings) {
  const ring = toPts(b.o);
  const bb = bbox(ring);
  bGrid.insertBox(ring, bb[0], bb[1], bb[2], bb[3]);
}
for (const a of areas) {
  if (!a.emb) continue;
  const ring = toPts(a.o);
  const bb = bbox(ring);
  bGrid.insertBox(ring, bb[0], bb[1], bb[2], bb[3]);
}
const insideBuilding = (p, pad = 0) => bGrid.query(p[0], p[1]).some((ring) => pointInRing(p, ring) || (pad && distToRing(p, [...ring, ring[0]]) < pad));

const sGrid = new Grid(40); // road + path segments with half-width
for (const r of [...roads, ...paths]) {
  if (r.e) continue;
  const pts = toPts(r.p);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], hw = r.w / 2;
    sGrid.insertBox({ a, b, hw, foot: !ROAD_WIDTH[r.k] || r.w < 4 }, Math.min(a[0], b[0]) - hw, Math.min(a[1], b[1]) - hw, Math.max(a[0], b[0]) + hw, Math.max(a[1], b[1]) + hw);
  }
}
const onPavement = (p, pad) => sGrid.query(p[0], p[1]).some((s) => distToSeg(p, s.a, s.b) < s.hw + pad);
const inWaterPoly = (p) => water.some((w) => pointInRing(p, toPts(w.o)) && !(w.holes || []).some((h) => pointInRing(p, toPts(h))));

const treeSet = [];
const tooClose = new Grid(6);
const plant = (p, minGap) => {
  if (tooClose.query(p[0], p[1]).some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < minGap)) return false;
  treeSet.push(p);
  tooClose.insertBox(p, p[0] - minGap, p[1] - minGap, p[0] + minGap, p[1] + minGap);
  return true;
};
for (let i = 0; i < trees.length; i += 2) plant([trees[i], trees[i + 1]], 2);

const STREET_TREE_ROADS = new Set(['residential', 'tertiary', 'secondary', 'primary', 'unclassified', 'living_street', 'pedestrian']);
const genLamps = [];
for (const r of roads) {
  if (r.e || !STREET_TREE_ROADS.has(r.k)) continue;
  const pts = toPts(r.p);
  let carry = 0, lampCarry = 17;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1) continue;
    const dir = [(b[0] - a[0]) / len, (b[1] - a[1]) / len], nrm = [-dir[1], dir[0]];
    const off = r.w / 2 + 1.3;
    for (let d = carry; d < len; d += 8) {
      for (const side of [-1, 1]) {
        if (rand() > 0.55) continue;
        const p = [a[0] + dir[0] * d + nrm[0] * off * side, a[1] + dir[1] * d + nrm[1] * off * side];
        if (!inScope(p) || insideBuilding(p, 1.2) || onPavement(p, 0.8) || inWaterPoly(p)) continue;
        plant(p.map((v) => Math.round(v * 10) / 10), 5);
      }
      carry = d + 8 - len;
    }
    for (let d = lampCarry; d < len; d += 32) {
      const side = (Math.floor(d / 32) + i) % 2 ? 1 : -1;
      const p = [a[0] + dir[0] * d + nrm[0] * (r.w / 2 + 0.5) * side, a[1] + dir[1] * d + nrm[1] * (r.w / 2 + 0.5) * side];
      if (!inScope(p, 60) || insideBuilding(p, 0.6) || onPavement(p, 0.2)) continue;
      genLamps.push(...p.map((v) => Math.round(v * 10) / 10));
      lampCarry = d + 32 - len;
    }
  }
}
// Parks and woods
const DENSITY = { park: 160, wood: 45, grass: 400, playground: 500 };
for (const a of areas) {
  const per = DENSITY[a.k];
  if (!per) continue;
  const ring = toPts(a.o);
  const area = Math.abs(ringArea(ring));
  const bb = bbox(ring);
  const n = Math.min(4000, Math.round(area / per));
  for (let i = 0, tries = 0; i < n && tries < n * 6; tries++) {
    const p = [bb[0] + rand() * (bb[2] - bb[0]), bb[1] + rand() * (bb[3] - bb[1])];
    if (!pointInRing(p, ring) || !inScope(p) || onPavement(p, 1.2)) continue;
    if (a.emb ? distToRing(p, [...ring, ring[0]]) < 1.5 : insideBuilding(p, 1.5)) continue;
    const q = p.map((v) => Math.round(v * 10) / 10);
    if (a.emb) q.push(a.emb);
    if (plant(q, a.k === 'wood' ? 3.5 : 6)) i++;
  }
}
trees.length = 0;
const raisedTrees = []; // [east, north, base height]
for (const p of treeSet) (p.length > 2 ? raisedTrees : trees).push(...p);

// ---------------------------------------------------------------- LiDAR terrain + trees
let terrain = null;
let landTerrain = [];
const lidarTrees = []; // [east, north, ground z, height, crown radius]
if (lidar) {
  const embAreas = areas.filter((a) => a.emb);
  const t = buildTerrain(lidar.dtm, { embankments: embAreas });
  // Measured heights; 0 means LiDAR shows no raised deck there, so it's a plain area after all.
  t.embHeights.forEach((h, i) => { if (h) embAreas[i].emb = h; else if (h === 0) delete embAreas[i].emb; });
  await mkdir('public/data', { recursive: true });
  await writeFile('public/data/terrain.bin', Buffer.from(t.cm.buffer));
  terrain = { ...t.grid, file: 'terrain.bin', source: lidar.dtm.dataset };
  // Land inside the terrain grid is draped over it (keeping exact shorelines); outside it's flat.
  const [tx0, ty0, tx1, ty1] = t.grid.extent;
  const hole = rect(tx0, ty0, tx1, ty1);
  const landGeom = land.map((l) => [l.o, ...(l.holes || [])].map((f) => { const r = toPts(f); r.push(r[0]); return r; }));
  const back = (poly) => { const rings = poly.map((r) => openRing(r).flat()); return rings.length > 1 ? { o: rings[0], holes: rings.slice(1) } : { o: rings[0] }; };
  landTerrain = polygonClipping.intersection(landGeom, [hole]).map(back);
  // Plateaus in focus areas are drawn as solid blocks with vertical walls, not draped land.
  const plateauGeom = focusAreas.flatMap((fa) => fa.terrain?.plateaus || []).map((pl) => [pl.o, ...(pl.holes || [])].map((f) => { const r = toPts(f); r.push(r[0]); return r; }));
  if (plateauGeom.length) landTerrain = polygonClipping.difference(landTerrain.map((l) => [l.o, ...(l.holes || [])].map((f) => { const r = toPts(f); r.push(r[0]); return r; })), ...plateauGeom.map((g) => [g])).map(back);
  land = polygonClipping.difference(landGeom, [hole]).map(back);
  // Measured trees replace generated ones inside the LiDAR extent.
  const inExtent = (x, y) => x > tx0 && x < tx1 && y > ty0 && y < ty1;
  for (const tr of lidar.trees.trees) if (inScope([tr[0], tr[1]])) lidarTrees.push(...tr);
  const keep = [];
  for (let i = 0; i < trees.length; i += 2) if (!inExtent(trees[i], trees[i + 1])) keep.push(trees[i], trees[i + 1]);
  trees.length = 0;
  trees.push(...keep);
  raisedTrees.length = 0;
}

// ---------------------------------------------------------------- focus areas
// Measured curbs: split each focus street at the area's edge; the inside pieces get per-side
// widths (left/right of the way's own direction) from LiDAR curb profiles.
for (const fa of focusAreas) {
  if (!fa.streets) continue;
  const [fcx, fcy] = proj(fa.center[1], fa.center[0]);
  const lim = fa.radius + 20;
  const inside = (p) => Math.hypot(p[0] - fcx, p[1] - fcy) <= lim;
  const out = [];
  for (const r of roads) {
    const st = r.n && fa.streets[r.n];
    const pts = toPts(r.p);
    if (!st || r.e || !pts.some(inside)) { out.push(r); continue; }
    // densify to 4 m so the split lands near the boundary
    const dense = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const [a, b] = [pts[i - 1], pts[i]], L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(L / 4));
      for (let k = 1; k <= n; k++) dense.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
    }
    let run = [dense[0]], runIn = inside(dense[0]);
    const flush = () => {
      if (run.length < 2) return;
      const piece = { ...r, p: run.flat().map((v) => Math.round(v * 10) / 10) };
      if (runIn) {
        const d = [run[run.length - 1][0] - run[0][0], run[run.length - 1][1] - run[0][1]];
        const same = d[0] * st.dir[0] + d[1] * st.dir[1] >= 0;
        const L = same ? st.left : st.right, R = same ? st.right : st.left;
        if (L) piece.wl = L;
        if (R) piece.wr = R;
        piece.w = Math.round(((piece.wl ?? r.w / 2) + (piece.wr ?? r.w / 2)) * 10) / 10;
        piece.curbs = fa.name;
      }
      out.push(piece);
    };
    for (let i = 1; i < dense.length; i++) {
      const io = inside(dense[i]);
      run.push(dense[i]);
      if (io !== runIn) { flush(); run = [dense[i]]; runIn = io; }
    }
    flush();
  }
  roads.length = 0;
  roads.push(...out);
}

// Cuts mapped as tunnels (open in reality, between retaining walls) are drawn at street level.
for (const fa of focusAreas) {
  for (const t of fa.terrain?.tunnels || []) roads.push({ k: t.k, w: t.w, p: t.p, n: t.name || undefined, cut: 1 });
  for (const pl of fa.terrain?.plateaus || []) areas.push({ k: 'plateau', o: pl.o, holes: pl.holes, focus: fa.name });
}
const focusTerrain = focusAreas.filter((fa) => fa.terrain).map((fa) => ({ name: fa.name, ...fa.terrain.patch }));

// ---------------------------------------------------------------- storefront signs
const businesses = collectBusinesses(osmPois, places, proj).filter((b) => inScope(b.p, 60));
const { signs, skipped: signsSkipped } = placeSigns(businesses, buildings, roads);

// ---------------------------------------------------------------- facade kits & colours
// (needs building ids, which are assigned just before writing; use the Overture ids now)
for (const b of buildings) b.id = b._id.replace(/-/g, '').slice(0, 12);
const facadeStats = annotateFacades(buildings, roads, { signs, photoColours });

// ---------------------------------------------------------------- street furniture
const street = buildStreetFurniture({ mapillary, osmPois, proj, inScope, buildings, roads: [...roads, ...paths] });
const furniture = street.items;
// Generated lamps only fill streets where no real lamp (photo-detected or mapped) is nearby.
const realLamps = new Grid(40);
for (const f of furniture) if (f.k === 'lamp') realLamps.insertBox(f, f.x - 40, f.y - 40, f.x + 40, f.y + 40);
for (let i = 0; i < genLamps.length; i += 2) {
  const x = genLamps[i], y = genLamps[i + 1];
  if (!realLamps.query(x, y).some((f) => Math.hypot(f.x - x, f.y - y) < 35)) lamps.push(x, y);
}

// ---------------------------------------------------------------- write
const city = {
  meta: {
    origin: ORIGIN,
    units: 'meters, [east, north] relative to origin',
    sources: [
      'Buildings: Overture Maps Foundation (OSM footprints; heights from USGS 3DEP LiDAR & Microsoft ML)',
      'Streets, water, parks, trees, businesses: © OpenStreetMap contributors (ODbL)',
      'Storeys, year built, construction, addresses: NJ Parcels & MOD-IV tax records (NJOGIS)',
      imagery ? `Roof colours: USDA NAIP ${imagery.date} aerial photo (30 cm, public domain)` : null,
      'Additional business names: Overture Maps places (CDLA-Permissive-2.0)',
      lidar ? `Terrain, trees, roof levels: USGS 3DEP LiDAR (${lidar.dtm.dataset}), trees checked against NAIP ${lidar.trees.ndvi_year} infrared` : null,
      Object.keys(photoColours).length ? 'Facade colours: sampled from Mapillary street-level photos (CC-BY-SA)' : null,
      mapillary.length ? 'Street furniture & traffic signs: Mapillary map features (CC-BY-SA), positions triangulated from street-level photos' : null,
    ].filter(Boolean),
    contextMeters: CONTEXT_M,
    generated: new Date().toISOString(),
  },
  boundary: boundary.flat(),
  buildings,
  skyline,
  roads,
  paths,
  rails,
  areas,
  water,
  land,
  landTerrain,
  terrain,
  focusTerrain,
  trees,
  raisedTrees,
  lidarTrees,
  lamps,
  signals,
  signs,
  furniture,
};

// Short stable id (from the Overture id) for joining per-building products like facade colours.
for (const b of buildings) delete b._id;
for (const b of skyline) delete b._id;
await mkdir('public/data', { recursive: true });
const json = JSON.stringify(city);
await writeFile('public/data/city.json', json);
const est = buildings.filter((b) => b.est).length;
console.log(`buildings ${buildings.length} (${est} with estimated height), skyline ${skyline.length}`);
console.log(`land ${land.length} polygons`);
console.log(`roads ${roads.length}, paths ${paths.length}, rails ${rails.length}, areas ${areas.length}, water ${water.length}`);
console.log(`embankment blocks ${areas.filter((a) => a.emb).length}, raised trees ${raisedTrees.length / 3}`);
console.log(`trees ${trees.length / 2}, lamps ${lamps.length / 2}, signals ${signals.length / 2}`);
console.log(`parcels joined ${parcelStats}/${buildings.length}, roof colours ${roofStats}, heights from storeys ${buildings.filter((b) => b.est === 'storeys').length}`);
console.log(`businesses ${businesses.length} -> signs ${signs.length} (osm ${signs.filter((s) => s.src === 'osm').length}), skipped ${signsSkipped}`);
const fk = furniture.reduce((a, f) => ((a[f.k] = (a[f.k] || 0) + 1), a), {});
console.log(`furniture ${furniture.length} (mapillary ${street.fromMly}, osm ${street.fromOsm}, sign posts ${street.posts}), generated lamps ${lamps.length / 2}`);
console.log('  ' + Object.entries(fk).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));
if (lidar) console.log(`LiDAR: terrain ${terrain.w}x${terrain.h} @${terrain.res}m, trees ${lidarTrees.length / 5} (+${trees.length / 2} generated outside), roofs with parts ${lidarRoofs}, not in 2014 scan ${lidarAbsent}, embankment heights ${areas.filter((a) => a.emb).map((a) => a.emb).join('/')}`);
console.log(`facades: kits ${Object.entries(facadeStats.kits).map(([k, v]) => `${k} ${v}`).join(', ')}; storefronts ${facadeStats.shops}, cornices ${facadeStats.cornices}, stoops ${facadeStats.stoops}, photo colours ${facadeStats.photo} (+${facadeStats.guided || 0} photo-guided)`);
console.log(`boundary ${boundary.length} pts; wrote public/data/city.json (${(json.length / 1e6).toFixed(2)} MB)`);
