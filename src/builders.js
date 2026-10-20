import * as THREE from 'three';
import { toPts, orient, hash01 } from './geo.js';
import { Terrain, drape } from './terrain.js';

export const BAY_M = 3.2; // window bay width
export const FLOOR_M = 3.4; // storey height
const TILE = 4; // bays/floors per texture tile

// Layer heights above the ground for coplanar features (logarithmic depth buffer keeps these
// stable). Draped layers need a little more separation to absorb interpolation differences.
export const Y = { land: 0, area: 0.03, path: 0.05, road: 0.07, mark: 0.09, rail: 0.08 };

// Ground the builders sit things on. world.js sets it before building anything.
let T = new Terrain(null, null);
export function setTerrain(terrain) {
  T = terrain;
  if (!terrain.flat) Object.assign(Y, { area: 0.05, path: 0.08, road: 0.11, mark: 0.14, rail: 0.12 });
}
export const ground = (e, n) => T.height(e, n);
const minGround = (ring) => ring.reduce((m, p) => Math.min(m, T.height(p[0], p[1])), Infinity);

// Accumulates non-indexed triangles.
class GeoBuffer {
  constructor({ uv = false, color = true } = {}) {
    this.pos = [];
    this.nrm = [];
    this.uv = uv ? [] : null;
    this.col = color ? [] : null;
  }
  v(x, y, z, nx, ny, nz, u, w, c) {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    if (this.uv) this.uv.push(u, w);
    if (this.col) this.col.push(c.r, c.g, c.b);
  }
  // Flat upward-facing triangle from three [east, north] points.
  triUp(a, b, c, y, col) {
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (cross < 0) [b, c] = [c, b];
    this.v(a[0], y, -a[1], 0, 1, 0, 0, 0, col);
    this.v(b[0], y, -b[1], 0, 1, 0, 0, 0, col);
    this.v(c[0], y, -c[1], 0, 1, 0, 0, 0, col);
  }
  // Vertical quad a->b, outward normal on the right-hand side of a->b. Bottom/top heights can
  // differ at each end (ya0/yb0, ya1/yb1) for walls that follow the ground.
  wall(a, b, y0, y1, col, u0 = 0, u1 = 0, v0 = 0, v1 = 0, yb0 = y0, yb1 = y1) {
    const de = b[0] - a[0], dn = b[1] - a[1];
    const len = Math.hypot(de, dn) || 1;
    const nx = dn / len, nz = de / len;
    const A = [a[0], y0, -a[1], u0, v0], B = [b[0], yb0, -b[1], u1, v0];
    const C = [b[0], yb1, -b[1], u1, v1], D = [a[0], y1, -a[1], u0, v1];
    for (const p of [A, B, C, A, C, D]) this.v(p[0], p[1], p[2], nx, 0, nz, p[3], p[4], col);
  }
  get count() {
    return this.pos.length / 3;
  }
  // draped: subdivide and lift onto the terrain (y values become offsets above the ground).
  toGeometry(draped = false, maxEdge = 7) {
    let attrs = { position: { array: this.pos, size: 3 }, normal: { array: this.nrm, size: 3 } };
    if (this.uv) attrs.uv = { array: this.uv, size: 2 };
    if (this.col) attrs.color = { array: this.col, size: 3 };
    if (draped) attrs = drape(attrs, T, maxEdge);
    const g = new THREE.BufferGeometry();
    for (const [name, { array, size }] of Object.entries(attrs)) g.setAttribute(name, new THREE.Float32BufferAttribute(array, size));
    g.computeBoundingSphere();
    return g;
  }
}

const color = (hex) => new THREE.Color(hex);
const palette = (list) => list.map(color);

const BRICK = palette(['#8e4b3b', '#7d4434', '#9b5a45', '#6b4a3a', '#a0644c', '#5e4339', '#b07a5e', '#874f3f']);
// Pre-1900 masonry here is dominated by brownstone fronts and darker hand-made brick.
const BROWNSTONE = palette(['#6b4a3a', '#5e4339', '#7a5644', '#5a3f33', '#7d4434', '#6e4b3e']);
const SIDING = palette(['#e6e2d6', '#d8d3c4', '#c9cdc9', '#b9c3c6', '#d9cfb8', '#a8b0a4', '#cfc7bd', '#9aa5ab']);
const CONCRETE = palette(['#b7b0a3', '#a9a397', '#c4beb2', '#9c978d', '#bdb5a5']);
const PAINTED = palette(['#c8b9a4', '#d6ccb8', '#a9a39a', '#9aa3a8', '#bfae94', '#e0d8c8', '#8d8a85']);
const GLASS = palette(['#6f8496', '#5d6e7e', '#7d93a3', '#4d5d6c', '#8a9daa', '#6b7f7a', '#95a3ad']);
const ROOF = palette(['#4a4a4c', '#555352', '#5f5d5a', '#3f4042', '#6a6865', '#7b7a76']);
const PLAIN = palette(['#8d8780', '#9c958c', '#7b766f']);
const pick = (list, r) => list[Math.floor(r * list.length)];

// Facade colour. Exact colours come from data where mapped (facade_color); otherwise the
// palette follows the recorded construction material and era, and the shade is a stable guess.
function facadeColor(b, i, style) {
  if (b.fc && /^#[0-9a-f]{6}$/i.test(b.fc)) return color(b.fc);
  const r = hash01(i * 7 + 3);
  if (style === 'glass') return pick(GLASS, r);
  if (style === 'plain') return pick(PLAIN, r);
  const mat = b.tax?.material || '';
  const year = b.tax?.year;
  if (/^frame|siding/.test(mat)) return pick(SIDING, r);
  if (/^brick/.test(mat)) return pick(year && year < 1900 && hash01(i * 13 + 1) < 0.45 ? BROWNSTONE : BRICK, r);
  if (/concrete|stone|stucco/.test(mat)) return pick(CONCRETE, r);
  // Unknown material: taller buildings skew towards painted/precast, rowhouses towards brick.
  const brickChance = b.h < 16 ? 0.72 : 0.35;
  return pick(hash01(i * 13 + 1) < brickChance ? BRICK : PAINTED, r);
}

function styleOf(b) {
  const h = b.h - (b.mh || 0);
  if (h <= 4.5 || ['roof', 'shed', 'garage', 'garages', 'carport'].includes(b.c)) return 'plain';
  if (b.h >= 40 || (b.tax?.year >= 2000 && b.h >= 25)) return 'glass';
  return 'masonry';
}

// Storey height for the window grid: the recorded storey count when it agrees with the height.
function floorHeight(b) {
  const st = b.tax?.storeys;
  if (st) {
    const fh = (b.h - (b.mh || 0)) / Math.ceil(st);
    if (fh >= 2.4 && fh <= 6) return fh;
  }
  return FLOOR_M;
}

function triangulate(outer, holes) {
  const contour = outer.map(([x, y]) => new THREE.Vector2(x, y));
  const hv = holes.map((h) => h.map(([x, y]) => new THREE.Vector2(x, y)));
  const verts = outer.concat(...holes);
  return { verts, faces: THREE.ShapeUtils.triangulateShape(contour, hv) };
}

function capPolygon(buf, outer, holes, y, col) {
  const { verts, faces } = triangulate(outer, holes);
  for (const [a, b, c] of faces) buf.triUp(verts[a], verts[b], verts[c], y, col);
}

// Extruded footprints. Walls are split by facade style so each gets its own texture.
export function buildBuildings(list, { masonryMap, glassMap }) {
  const bufs = {
    masonry: new GeoBuffer({ uv: true }),
    glass: new GeoBuffer({ uv: true }),
    plain: new GeoBuffer(),
    roof: new GeoBuffer(),
  };
  list.forEach((b, i) => {
    const outer = orient(toPts(b.o), true);
    const holes = (b.holes || []).map((h) => orient(toPts(h), false));
    const top = b.h, bot = b.mh || 0;
    if (top - bot < 0.5 || outer.length < 3) return;
    // Buildings stand on the lowest ground point of their footprint; walls run below grade uphill.
    const base = minGround(outer);
    b._base = base;
    b._top = base + Math.max(top, ...(b.parts || []).map((p) => p.h));
    const style = styleOf(b);
    const col = facadeColor(b, i, style);
    const buf = bufs[style];
    const fh = floorHeight(b) * TILE;
    const extrude = (rings, y0, y1) => {
      for (const ring of rings)
        for (let k = 0; k < ring.length; k++) {
          const a = ring[k], c = ring[(k + 1) % ring.length];
          const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
          if (len < 0.05) continue;
          // Whole number of bays per facade so windows are never sliced at corners.
          const bays = len < 2 ? 0 : Math.max(1, Math.round(len / BAY_M));
          const u1 = bays ? bays / TILE : 0.02;
          buf.wall(a, c, base + y0, base + y1, col, bays ? 0 : 0.02, u1, y0 / fh, y1 / fh);
        }
    };
    extrude([outer, ...holes], bot, top);
    // Roof colour sampled from the 2023 aerial photo; random grey only where it couldn't be.
    const rc = b.rc ? color(b.rc) : ROOF[Math.floor(hash01(i * 31 + 5) * ROOF.length)];
    try {
      capPolygon(bufs.roof, outer, holes, base + top, rc);
    } catch {
      /* degenerate footprint */
    }
    // Raised roof levels measured by LiDAR (towers, setbacks, bulkheads), stacked on the roof.
    for (const p of b.parts || []) {
      const ring = orient(toPts(p.o), true);
      if (ring.length < 3 || p.h - p.mh < 0.5) continue;
      extrude([ring], p.mh, p.h);
      try {
        capPolygon(bufs.roof, ring, [], base + p.h, rc);
      } catch {
        /* skip */
      }
    }
  });

  const group = new THREE.Group();
  const mats = {
    masonry: new THREE.MeshStandardMaterial({ vertexColors: true, map: masonryMap, roughness: 0.9 }),
    glass: new THREE.MeshStandardMaterial({ vertexColors: true, map: glassMap, roughness: 0.25, metalness: 0.55 }),
    plain: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }),
    roof: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }),
  };
  for (const [k, buf] of Object.entries(bufs)) {
    if (!buf.count) continue;
    const mesh = new THREE.Mesh(buf.toGeometry(), mats[k]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `buildings-${k}`;
    group.add(mesh);
  }
  return group;
}

// Filled ground polygons (parks, plazas...) with a colour per kind. Draped over the terrain
// unless `draped` is false (the huge flat land polygon beyond the terrain grid).
export function buildFlatAreas(list, y, colorOf, { draped = true, maxEdge = 7 } = {}) {
  const buf = new GeoBuffer();
  for (const a of list) {
    const col = colorOf(a);
    if (!col) continue;
    const outer = orient(toPts(a.o), true);
    const holes = (a.holes || []).map((h) => orient(toPts(h), false));
    if (outer.length < 3) continue;
    try {
      capPolygon(buf, outer, holes, typeof y === 'function' ? y(a) : y, col);
    } catch {
      /* skip */
    }
  }
  const mesh = new THREE.Mesh(buf.toGeometry(draped, maxEdge), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
  mesh.receiveShadow = true;
  return mesh;
}

// Raised stone blocks (Sixth Street Embankment) with an overgrown top.
export function buildEmbankment(areas) {
  const walls = new GeoBuffer();
  const top = new GeoBuffer();
  const stone = color('#7d7263'), green = color('#56743f');
  for (const a of areas) {
    const outer = orient(toPts(a.o), true);
    // Deck height measured by LiDAR above the street beside it; the deck is level.
    const deck = outer.reduce((s, p) => s + ground(p[0], p[1]), 0) / outer.length + a.emb;
    const base = minGround(outer) - 0.5;
    for (let k = 0; k < outer.length; k++) walls.wall(outer[k], outer[(k + 1) % outer.length], base, deck, stone);
    try {
      capPolygon(top, outer, [], deck, green);
    } catch {
      /* skip */
    }
  }
  const group = new THREE.Group();
  for (const [buf, rough] of [[walls, 1], [top, 1]]) {
    const mesh = new THREE.Mesh(buf.toGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: rough }));
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

// Vertical bulkhead along every land edge that meets the river, from the river bed up to the
// ground at the shoreline.
export function buildSeawall(land, top = 0.02, skipEdge = () => false) {
  const buf = new GeoBuffer();
  const col = color('#6d6961');
  for (const l of land) {
    const rings = [orient(toPts(l.o), true), ...(l.holes || []).map((h) => orient(toPts(h), false))];
    for (const ring of rings)
      for (let k = 0; k < ring.length; k++) {
        const a = ring[k], b = ring[(k + 1) % ring.length];
        if (Math.max(Math.abs(a[0]), Math.abs(a[1]), Math.abs(b[0]), Math.abs(b[1])) > 29000 || skipEdge(a, b)) continue;
        // Long edges get split so the top follows the ground.
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const n = Math.max(1, Math.ceil(len / 6));
        for (let s = 0; s < n; s++) {
          const p = [a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n];
          const q = [a[0] + ((b[0] - a[0]) * (s + 1)) / n, a[1] + ((b[1] - a[1]) * (s + 1)) / n];
          buf.wall(p, q, T.bed, ground(p[0], p[1]) + top, col, 0, 0, 0, 0, T.bed, ground(q[0], q[1]) + top);
        }
      }
  }
  const mesh = new THREE.Mesh(buf.toGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
  mesh.receiveShadow = true;
  return mesh;
}

// --------------------------------------------------------------------------- linear features

// Offsets a polyline into left/right edges with mitred joins.
function offsetLine(pts, hw) {
  const n = pts.length;
  const segN = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0], dy = pts[i + 1][1] - pts[i][1];
    const l = Math.hypot(dx, dy) || 1;
    segN.push([-dy / l, dx / l]);
  }
  const left = [], right = [];
  for (let i = 0; i < n; i++) {
    let m;
    let s = 1;
    if (i === 0) m = segN[0];
    else if (i === n - 1) m = segN[n - 2];
    else {
      const a = segN[i - 1], b = segN[i];
      m = [a[0] + b[0], a[1] + b[1]];
      const l = Math.hypot(m[0], m[1]);
      if (l < 1e-6) m = b;
      else {
        m = [m[0] / l, m[1] / l];
        s = Math.min(3, 1 / Math.max(0.33, m[0] * b[0] + m[1] * b[1]));
      }
    }
    left.push([pts[i][0] + m[0] * hw * s, pts[i][1] + m[1] * hw * s]);
    right.push([pts[i][0] - m[0] * hw * s, pts[i][1] - m[1] * hw * s]);
  }
  return { left, right };
}

function dedupe(pts) {
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.05) out.push(p);
  }
  return out;
}

// Elevation profile: viaduct ways ramp down to grade at ends that only meet ground-level roads.
function elevationProfile(pts, e, rampStart, rampEnd) {
  const n = pts.length;
  const dist = [0];
  for (let i = 1; i < n; i++) dist.push(dist[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = dist[n - 1];
  const ramp = Math.min(90, total / 2);
  return dist.map((d) => {
    let f = 1;
    if (rampStart) f = Math.min(f, d / ramp);
    if (rampEnd) f = Math.min(f, (total - d) / ramp);
    return e * Math.max(0, f);
  });
}

export function buildRibbons(list, { y, colorOf, caps = true, elevated = null }) {
  const buf = new GeoBuffer();
  const deck = new GeoBuffer();
  const pillars = [];
  const deckCol = color('#8a867f');
  for (const r of list) {
    const pts = dedupe(toPts(r.p));
    if (pts.length < 2) continue;
    const col = colorOf(r);
    const hw = r.w / 2;
    const { left, right } = offsetLine(pts, hw);
    const elev = r.e && elevated ? elevationProfile(pts, r.e, elevated.rampStart(r), elevated.rampEnd(r)) : null;
    const yAt = (i) => (elev ? elev[i] : 0) + y;
    for (let i = 0; i < pts.length - 1; i++) {
      const y0 = yAt(i), y1 = yAt(i + 1);
      if (!elev) {
        buf.triUp(left[i], right[i], right[i + 1], y, col);
        buf.triUp(left[i], right[i + 1], left[i + 1], y, col);
        continue;
      }
      // Sloped deck: emit explicitly (triUp is flat).
      const quad = [
        [left[i], y0], [right[i], y0], [right[i + 1], y1],
        [left[i], y0], [right[i + 1], y1], [left[i + 1], y1],
      ];
      const ab = [right[i][0] - left[i][0], right[i][1] - left[i][1]];
      const ac = [right[i + 1][0] - left[i][0], right[i + 1][1] - left[i][1]];
      const flip = ab[0] * ac[1] - ab[1] * ac[0] < 0;
      const order = flip ? [0, 2, 1, 3, 5, 4] : [0, 1, 2, 3, 4, 5];
      for (const k of order) buf.v(quad[k][0][0], quad[k][1], -quad[k][0][1], 0, 1, 0, 0, 0, col);
      // Deck edges and pillars where the road is actually raised.
      if (Math.max(y0, y1) > 1.5) {
        const t = 1.3;
        deck.wall(right[i], right[i + 1], Math.max(0, y0 - t), y0 + 0.9, deckCol, 0, 0, 0, 0, Math.max(0, y1 - t), y1 + 0.9);
        deck.wall(left[i + 1], left[i], Math.max(0, y1 - t), y1 + 0.9, deckCol, 0, 0, 0, 0, Math.max(0, y0 - t), y0 + 0.9);
        const segLen = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
        for (let d = 0; d < segLen; d += 28) {
          const f = d / segLen;
          const yy = y0 + (y1 - y0) * f - t;
          if (yy > 2) pillars.push([pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f, yy, r.w]);
        }
      }
    }
    if (caps && !elev) {
      // Round-ish end caps hide gaps where separate ways meet at an angle.
      for (const p of [pts[0], pts[pts.length - 1]]) {
        const seg = 8;
        for (let s = 0; s < seg; s++) {
          const a0 = (s / seg) * Math.PI * 2, a1 = ((s + 1) / seg) * Math.PI * 2;
          buf.triUp(p, [p[0] + Math.cos(a0) * hw, p[1] + Math.sin(a0) * hw], [p[0] + Math.cos(a1) * hw, p[1] + Math.sin(a1) * hw], y, col);
        }
      }
    }
  }
  const group = new THREE.Group();
  const surface = new THREE.Mesh(buf.toGeometry(true), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
  surface.receiveShadow = true;
  surface.castShadow = !!elevated;
  group.add(surface);
  if (deck.count) {
    const m = new THREE.Mesh(deck.toGeometry(true, 8), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide }));
    m.castShadow = m.receiveShadow = true;
    group.add(m);
  }
  if (pillars.length) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    const inst = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: '#8f8b84', roughness: 0.9 }), pillars.length);
    const m4 = new THREE.Matrix4();
    pillars.forEach(([e, n, h, w], i) => {
      m4.makeScale(1.4, h, Math.min(w * 0.6, 6));
      m4.setPosition(e, ground(e, n), -n);
      inst.setMatrixAt(i, m4);
    });
    inst.castShadow = inst.receiveShadow = true;
    group.add(inst);
  }
  return group;
}

// Zebra stripes along mapped crosswalks.
export function buildCrosswalks(paths) {
  const buf = new GeoBuffer();
  const col = color('#d8d6cf');
  for (const p of paths) {
    if (p.f !== 'crossing') continue;
    const pts = dedupe(toPts(p.p));
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1) continue;
      const d = [(b[0] - a[0]) / len, (b[1] - a[1]) / len], nrm = [-d[1], d[0]];
      for (let s = 0.3; s + 0.5 < len; s += 1.1) {
        const c0 = [a[0] + d[0] * s, a[1] + d[1] * s], c1 = [a[0] + d[0] * (s + 0.5), a[1] + d[1] * (s + 0.5)];
        const q = [
          [c0[0] + nrm[0] * 1.5, c0[1] + nrm[1] * 1.5], [c0[0] - nrm[0] * 1.5, c0[1] - nrm[1] * 1.5],
          [c1[0] - nrm[0] * 1.5, c1[1] - nrm[1] * 1.5], [c1[0] + nrm[0] * 1.5, c1[1] + nrm[1] * 1.5],
        ];
        buf.triUp(q[0], q[1], q[2], Y.mark, col);
        buf.triUp(q[0], q[2], q[3], Y.mark, col);
      }
    }
  }
  const mesh = new THREE.Mesh(buf.toGeometry(true), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }));
  mesh.receiveShadow = true;
  return mesh;
}

// Ballast bed plus two steel rails.
export function buildRails(rails) {
  const bed = rails.map((r) => ({ ...r, w: 3.4 }));
  const group = buildRibbons(bed, { y: Y.rail, colorOf: () => color('#6b6258'), caps: false, elevated: { rampStart: () => true, rampEnd: () => true } });
  const steel = [];
  for (const r of rails) {
    const pts = dedupe(toPts(r.p));
    if (pts.length < 2 || r.e) continue;
    const { left, right } = offsetLine(pts, 0.72);
    steel.push({ p: left.flat(), w: 0.12 }, { p: right.flat(), w: 0.12 });
  }
  group.add(buildRibbons(steel, { y: Y.rail + 0.06, colorOf: () => color('#3b3a38'), caps: false }));
  return group;
}

// Tileable ripple normal map: a sum of waves with integer wave vectors wraps seamlessly.
function rippleNormalMap(renderer, size = 256) {
  const waves = [];
  let seed = 99;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 14; i++) {
    const kx = Math.round((rnd() - 0.5) * 16), ky = Math.round((rnd() - 0.5) * 16);
    if (!kx && !ky) continue;
    waves.push({ kx, ky, a: 1 / Math.hypot(kx, ky), ph: rnd() * Math.PI * 2 });
  }
  const img = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let dx = 0, dy = 0;
      for (const w of waves) {
        const c = Math.cos(((w.kx * x + w.ky * y) / size) * Math.PI * 2 + w.ph) * w.a;
        dx += c * w.kx;
        dy += c * w.ky;
      }
      const n = new THREE.Vector3(-dx * 0.08, -dy * 0.08, 1).normalize();
      const i = (y * size + x) * 4;
      img[i] = (n.x * 0.5 + 0.5) * 255;
      img[i + 1] = (n.y * 0.5 + 0.5) * 255;
      img[i + 2] = (n.z * 0.5 + 0.5) * 255;
      img[i + 3] = 255;
    }
  const tex = new THREE.DataTexture(img, size, size);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.needsUpdate = true;
  return tex;
}

export function buildWater(renderer, size = 60000) {
  const geo = new THREE.PlaneGeometry(size, size);
  geo.rotateX(-Math.PI / 2);
  const normalMap = rippleNormalMap(renderer);
  normalMap.repeat.set(size / 20, size / 20);
  const mat = new THREE.MeshStandardMaterial({
    color: '#16303c', roughness: 0.08, metalness: 0.05, normalMap, normalScale: new THREE.Vector2(0.22, 0.22), envMapIntensity: 1.4,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = T.waterLevel;
  mesh.receiveShadow = true;
  mesh.name = 'water';
  // Drift the ripples with the tide.
  mesh.userData.update = (t) => normalMap.offset.set(t * 0.012, t * 0.007);
  return mesh;
}

// --------------------------------------------------------------------------- lane markings
// From OSM oneway/lanes tags: double yellow centre lines on two-way main streets, dashed white
// lines between same-direction lanes (US urban 3 m dash / 9 m gap). Lines stop short of junctions.
const CAR_ROADS = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);
const CENTRE_LINE_ROADS = new Set(['trunk', 'primary', 'secondary', 'tertiary']);

function cumulative(pts) {
  const d = [0];
  for (let i = 1; i < pts.length; i++) d.push(d[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return d;
}

// Sub-polyline between distances d0 and d1 along pts.
function slice(pts, dist, d0, d1) {
  const at = (d) => {
    let i = 1;
    while (i < dist.length - 1 && dist[i] < d) i++;
    const t = (d - dist[i - 1]) / (dist[i] - dist[i - 1] || 1);
    return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
  };
  const out = [at(d0)];
  for (let i = 0; i < pts.length; i++) if (dist[i] > d0 && dist[i] < d1) out.push(pts[i]);
  out.push(at(d1));
  return out;
}

export function buildLaneMarkings(roads) {
  const buf = new GeoBuffer();
  const yellow = color('#d4aa2c'), white = color('#e8e6df');
  const key = (x, y) => `${x},${y}`;
  const use = new Map();
  for (const r of roads) {
    if (!CAR_ROADS.has(r.k) || r.e) continue;
    const seen = new Set();
    for (let i = 0; i < r.p.length; i += 2) {
      const k = key(r.p[i], r.p[i + 1]);
      if (seen.has(k)) continue;
      seen.add(k);
      use.set(k, (use.get(k) || 0) + 1);
    }
  }
  const stripe = (pts, off, halfW, col) => {
    let line = pts;
    if (off) {
      const { left, right } = offsetLine(pts, Math.abs(off));
      line = off > 0 ? left : right;
    }
    const { left, right } = offsetLine(line, halfW);
    for (let i = 0; i < line.length - 1; i++) {
      buf.triUp(left[i], right[i], right[i + 1], Y.mark, col);
      buf.triUp(left[i], right[i + 1], left[i + 1], Y.mark, col);
    }
  };
  for (const r of roads) {
    if (!CAR_ROADS.has(r.k) || r.e || r.w < 6) continue;
    const pts = dedupe(toPts(r.p));
    if (pts.length < 2) continue;
    const dist = cumulative(pts);
    const L = dist[dist.length - 1];
    // Keep paint clear of intersections (any vertex shared with another road).
    const R = 7;
    const blocked = [];
    pts.forEach((p, i) => { if ((use.get(key(p[0], p[1])) || 0) > 1) blocked.push([dist[i] - R, dist[i] + R]); });
    const open = [];
    let cur = 0;
    for (const [b0, b1] of blocked.sort((a, b) => a[0] - b[0])) {
      if (b0 > cur + 2) open.push([cur, Math.min(b0, L)]);
      cur = Math.max(cur, b1);
    }
    if (L > cur + 2) open.push([cur, L]);
    if (!open.length) continue;

    const twoWay = !r.ow;
    const lanes = r.ln || (twoWay ? 2 : 1);
    if (twoWay && (CENTRE_LINE_ROADS.has(r.k) || r.ln >= 2)) {
      for (const [a, b] of open) {
        const seg = slice(pts, dist, a, b);
        stripe(seg, 0.12, 0.055, yellow);
        stripe(seg, -0.12, 0.055, yellow);
      }
    }
    const perDir = twoWay ? Math.floor(lanes / 2) : lanes;
    if (perDir < 2) continue;
    const offsets = [];
    if (twoWay) {
      const lw = r.w / 2 / perDir;
      for (let k = 1; k < perDir; k++) offsets.push(k * lw, -k * lw);
    } else {
      const lw = r.w / perDir;
      for (let k = 1; k < perDir; k++) offsets.push(-r.w / 2 + k * lw);
    }
    for (const [a, b] of open)
      for (let d = a; d + 3 <= b; d += 12) {
        const seg = slice(pts, dist, d, d + 3);
        for (const o of offsets) stripe(seg, o, 0.06, white);
      }
  }
  const mesh = new THREE.Mesh(buf.toGeometry(true), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }));
  mesh.receiveShadow = true;
  mesh.name = 'lane-markings';
  return mesh;
}
