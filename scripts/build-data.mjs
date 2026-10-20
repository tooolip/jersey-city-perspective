// Converts raw OSM + Overture downloads into public/data/city.json, a compact
// scene description in local meters. Coordinates are [east, north] relative to ORIGIN.
// Usage: node scripts/build-data.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import polygonClipping from 'polygon-clipping';

const ORIGIN = { lat: 40.724, lon: -74.042 };
const M_PER_DEG_LAT = 111132.954 - 559.822 * Math.cos(2 * ORIGIN.lat * Math.PI / 180);
const M_PER_DEG_LON = 111412.84 * Math.cos(ORIGIN.lat * Math.PI / 180);

const proj = (lon, lat) => [
  Math.round((lon - ORIGIN.lon) * M_PER_DEG_LON * 10) / 10,
  Math.round((lat - ORIGIN.lat) * M_PER_DEG_LAT * 10) / 10,
];
const projLL = (p) => proj(p.lon, p.lat);

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

// ---------------------------------------------------------------- geometry utils
function segIntersect(a, b, c, d) {
  const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { t, u, p: [a[0] + t * r[0], a[1] + t * r[1]] } : null;
}

function pointInRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function distToRing(p, ring) {
  let d = Infinity;
  for (let i = 0; i < ring.length - 1; i++) d = Math.min(d, distToSeg(p, ring[i], ring[i + 1]));
  return d;
}

const toPts = (flat) => { const r = []; for (let i = 0; i < flat.length; i += 2) r.push([flat[i], flat[i + 1]]); return r; };
const bbox = (pts) => pts.reduce((b, p) => [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])], [Infinity, Infinity, -Infinity, -Infinity]);

const centroid = (ring) => {
  let x = 0, y = 0;
  for (const p of ring) { x += p[0]; y += p[1]; }
  return [x / ring.length, y / ring.length];
};

const ringArea = (ring) => {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return a / 2;
};

// Drop closing duplicate + consecutive duplicates.
function openRing(ring) {
  const out = [];
  for (const p of ring) {
    const q = out[out.length - 1];
    if (!q || q[0] !== p[0] || q[1] !== p[1]) out.push(p);
  }
  if (out.length > 1) {
    const f = out[0], l = out[out.length - 1];
    if (f[0] === l[0] && f[1] === l[1]) out.pop();
  }
  return out;
}

// Join way segments end-to-end into closed rings (OSM multipolygon assembly).
function assembleRings(lines) {
  const key = (p) => `${p[0]},${p[1]}`;
  const pool = lines.filter((l) => l.length > 1).map((l) => l.slice());
  const rings = [];
  while (pool.length) {
    let ring = pool.pop();
    let grew = true;
    while (key(ring[0]) !== key(ring[ring.length - 1]) && grew) {
      grew = false;
      const end = key(ring[ring.length - 1]);
      for (let i = 0; i < pool.length; i++) {
        const l = pool[i];
        if (key(l[0]) === end) ring = ring.concat(l.slice(1));
        else if (key(l[l.length - 1]) === end) ring = ring.concat(l.slice(0, -1).reverse());
        else continue;
        pool.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (ring.length >= 4) {
      if (key(ring[0]) !== key(ring[ring.length - 1])) ring.push(ring[0]);
      rings.push(ring);
    }
  }
  return rings;
}

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
      const b = { o: outer.flat(), h: Math.round(heightOf(pr, area) * 10) / 10 };
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
    else if (t.highway === 'street_lamp') lamps.push(...p);
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
const land = polygonClipping.difference([LAND_RECT], ...waterGeom.map((g) => [g])).map((poly) => {
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

class Grid {
  constructor(cell) { this.cell = cell; this.map = new Map(); }
  key(x, y) { return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`; }
  insertBox(item, x0, y0, x1, y1) {
    for (let x = Math.floor(x0 / this.cell); x <= Math.floor(x1 / this.cell); x++)
      for (let y = Math.floor(y0 / this.cell); y <= Math.floor(y1 / this.cell); y++) {
        const k = `${x},${y}`;
        if (!this.map.has(k)) this.map.set(k, []);
        this.map.get(k).push(item);
      }
  }
  query(x, y) { return this.map.get(this.key(x, y)) || []; }
}


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
lamps.push(...genLamps);

// ---------------------------------------------------------------- write
const city = {
  meta: {
    origin: ORIGIN,
    units: 'meters, [east, north] relative to origin',
    sources: [
      'Buildings: Overture Maps Foundation (OSM footprints; heights from USGS 3DEP LiDAR & Microsoft ML)',
      'Streets, water, parks, trees: © OpenStreetMap contributors (ODbL)',
    ],
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
  trees,
  raisedTrees,
  lamps,
  signals,
};

await mkdir('public/data', { recursive: true });
const json = JSON.stringify(city);
await writeFile('public/data/city.json', json);
const est = buildings.filter((b) => b.est).length;
console.log(`buildings ${buildings.length} (${est} with estimated height), skyline ${skyline.length}`);
console.log(`land ${land.length} polygons`);
console.log(`roads ${roads.length}, paths ${paths.length}, rails ${rails.length}, areas ${areas.length}, water ${water.length}`);
console.log(`embankment blocks ${areas.filter((a) => a.emb).length}, raised trees ${raisedTrees.length / 3}`);
console.log(`trees ${trees.length / 2}, lamps ${lamps.length / 2}, signals ${signals.length / 2}`);
console.log(`boundary ${boundary.length} pts; wrote public/data/city.json (${(json.length / 1e6).toFixed(2)} MB)`);
