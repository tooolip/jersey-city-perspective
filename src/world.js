import * as THREE from 'three';
import { toPts, bbox, pointInRing, distToRing, distToSeg, Grid } from './geo.js';
import { buildBuildings, buildEmbankment, buildFlatAreas, buildSeawall, buildRibbons, buildCrosswalks, buildRails, buildWater, Y } from './builders.js';
import { masonryTexture, glassTexture } from './textures.js';
import { buildTrees, buildLamps } from './props.js';

const AREA_COLORS = {
  park: '#6f8f4e', grass: '#7a9a55', wood: '#56743f', pitch: '#5f8d4a', playground: '#a88f6a',
  sand: '#cdbb8c', dirt: '#8a7a64', parking: '#5d5d5f', plaza: '#a29d93', platform: '#9a9590',
  pier: '#8e8576', water: '#3c5c6c',
};
const ROAD_COLORS = {
  motorway: '#3d3e40', trunk: '#3d3e40', primary: '#424345', secondary: '#454648', tertiary: '#48494b',
  service: '#525254', pedestrian: '#9b958a',
};
const PATH_COLORS = { footway: '#a8a399', cycleway: '#7a5550', path: '#8f8270', steps: '#9b958c', track: '#86796a', pedestrian: '#9b958a' };

const colorCache = new Map();
const c = (hex) => {
  if (!colorCache.has(hex)) colorCache.set(hex, new THREE.Color(hex));
  return colorCache.get(hex);
};

export function buildWorld(data, renderer) {
  const root = new THREE.Group();
  const masonryMap = masonryTexture(renderer);
  const glassMap = glassTexture(renderer);

  const water = buildWater(renderer);
  root.add(water);
  const land = buildFlatAreas(data.land, Y.land, () => c('#8f8b84'));
  land.name = 'land';
  root.add(land);
  root.add(buildSeawall(data.land));
  root.add(buildSeawall(data.areas.filter((a) => a.k === 'pier'), Y.area + 0.4));
  root.add(buildEmbankment(data.areas.filter((a) => a.emb)));
  root.add(buildFlatAreas(data.areas.filter((a) => !a.emb), (a) => (a.k === 'pier' ? Y.area + 0.4 : Y.area), (a) => c(AREA_COLORS[a.k] || '#888888')));

  // Roads: elevated ways ramp down where they meet only ground-level streets.
  const nodeUse = new Map();
  const key = (x, y) => `${x},${y}`;
  for (const r of data.roads)
    for (let i = 0; i < r.p.length; i += 2) {
      const k = key(r.p[i], r.p[i + 1]);
      nodeUse.set(k, (nodeUse.get(k) || 0) + (r.e ? 1 : 0));
    }
  const endIsGround = (r, atStart) => {
    const i = atStart ? 0 : r.p.length - 2;
    return (nodeUse.get(key(r.p[i], r.p[i + 1])) || 0) <= 1;
  };
  root.add(buildRibbons(data.roads, {
    y: Y.road,
    colorOf: (r) => c(ROAD_COLORS[r.k] || '#4a4b4d'),
    elevated: { rampStart: (r) => endIsGround(r, true), rampEnd: (r) => endIsGround(r, false) },
  }));
  root.add(buildRibbons(data.paths.filter((p) => p.f !== 'crossing'), { y: Y.path, colorOf: (p) => c(PATH_COLORS[p.k] || '#a8a399') }));
  root.add(buildCrosswalks(data.paths));
  root.add(buildRails(data.rails));

  const city = buildBuildings(data.buildings, { masonryMap, glassMap });
  city.name = 'jersey-city';
  root.add(city);
  const skyline = buildBuildings(data.skyline, { masonryMap, glassMap });
  skyline.name = 'manhattan';
  skyline.traverse((o) => { o.castShadow = false; });
  root.add(skyline);

  root.add(buildTrees(data.trees));
  if (data.raisedTrees?.length) root.add(buildTrees(data.raisedTrees, 3, 100000));
  root.add(buildLamps(data.lamps));

  return { root, query: new WorldQuery(data), update: (t) => water.userData.update(t) };
}

// Collision and lookup queries in [east, north] space.
export class WorldQuery {
  constructor(data) {
    this.boundary = toPts(data.boundary);
    this.buildings = new Grid(40);
    data.buildings.forEach((b) => {
      const ring = toPts(b.o);
      if ((b.mh || 0) > 2) return; // raised parts (canopies, skybridges) don't block walking
      this.buildings.insert({ ring, bb: bbox(ring), b }, bbox(ring));
    });
    data.areas.filter((a) => a.emb).forEach((a) => {
      const ring = toPts(a.o);
      this.buildings.insert({ ring, bb: bbox(ring), b: { n: 'Sixth Street Embankment', h: a.emb } }, bbox(ring));
    });
    this.water = data.water.map((w) => {
      const ring = toPts(w.o);
      return { ring, holes: (w.holes || []).map(toPts), bb: bbox(ring) };
    });
    this.piers = new Grid(40);
    data.areas.filter((a) => a.k === 'pier').forEach((a) => {
      const ring = toPts(a.o);
      this.piers.insert({ ring, bb: bbox(ring) }, bbox(ring));
    });
    this.streets = new Grid(30);
    for (const r of data.roads) {
      if (!r.n) continue;
      const pts = toPts(r.p);
      for (let i = 0; i < pts.length - 1; i++) {
        const s = { a: pts[i], b: pts[i + 1], name: r.n, w: r.w, e: r.e || 0 };
        this.streets.insert(s, [Math.min(s.a[0], s.b[0]) - 20, Math.min(s.a[1], s.b[1]) - 20, Math.max(s.a[0], s.b[0]) + 20, Math.max(s.a[1], s.b[1]) + 20]);
      }
    }
  }

  inBounds(x, y, margin = 30) {
    return pointInRing(x, y, this.boundary) || distToRing(x, y, this.boundary) < margin;
  }

  inBuilding(x, y, r = 0) {
    for (const { ring, bb } of this.buildings.query(x, y)) {
      if (x < bb[0] - r || x > bb[2] + r || y < bb[1] - r || y > bb[3] + r) continue;
      if (pointInRing(x, y, ring) || (r && distToRing(x, y, ring) < r)) return true;
    }
    return false;
  }

  buildingAt(x, y) {
    for (const item of this.buildings.query(x, y)) if (pointInRing(x, y, item.ring)) return item.b;
    return null;
  }

  inWater(x, y) {
    for (const p of this.piers.query(x, y)) if (pointInRing(x, y, p.ring)) return false;
    for (const w of this.water) {
      const bb = w.bb;
      if (x < bb[0] || x > bb[2] || y < bb[1] || y > bb[3]) continue;
      if (pointInRing(x, y, w.ring) && !w.holes.some((h) => pointInRing(x, y, h))) return true;
    }
    return false;
  }

  isWalkable(x, y, r = 0.35) {
    return this.inBounds(x, y) && !this.inBuilding(x, y, r) && !this.inWater(x, y);
  }

  // Spiral outwards to the closest walkable spot.
  nearestWalkable(x, y) {
    if (this.isWalkable(x, y)) return [x, y];
    for (let rad = 2; rad < 400; rad += 2)
      for (let a = 0; a < Math.PI * 2; a += 0.6 / Math.sqrt(rad)) {
        const px = x + Math.cos(a) * rad, py = y + Math.sin(a) * rad;
        if (this.isWalkable(px, py)) return [px, py];
      }
    return [x, y];
  }

  streetAt(x, y) {
    let best = null, bd = Infinity;
    for (const s of this.streets.query(x, y)) {
      if (s.e > 3) continue;
      const d = distToSeg(x, y, s.a[0], s.a[1], s.b[0], s.b[1]) - s.w / 2;
      if (d < bd) { bd = d; best = s.name; }
    }
    return bd < 14 ? best : null;
  }
}
