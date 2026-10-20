import * as THREE from 'three';
import { toPts, orient, hash01 } from './geo.js';

export const BAY_M = 3.2; // window bay width
export const FLOOR_M = 3.4; // storey height
const TILE = 4; // bays/floors per texture tile
export const WATER_Y = -1.6; // river surface relative to street level

// Layer heights for coplanar ground features (logarithmic depth buffer keeps these stable).
export const Y = { land: 0, area: 0.03, path: 0.05, road: 0.07, mark: 0.09, rail: 0.08 };

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
  // Vertical quad a->b, outward normal on the right-hand side of a->b.
  wall(a, b, y0, y1, col, u0 = 0, u1 = 0, v0 = 0, v1 = 0) {
    const de = b[0] - a[0], dn = b[1] - a[1];
    const len = Math.hypot(de, dn) || 1;
    const nx = dn / len, nz = de / len;
    const A = [a[0], y0, -a[1], u0, v0], B = [b[0], y0, -b[1], u1, v0];
    const C = [b[0], y1, -b[1], u1, v1], D = [a[0], y1, -a[1], u0, v1];
    for (const p of [A, B, C, A, C, D]) this.v(p[0], p[1], p[2], nx, 0, nz, p[3], p[4], col);
  }
  get count() {
    return this.pos.length / 3;
  }
  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    if (this.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.col) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    return g;
  }
}

const color = (hex) => new THREE.Color(hex);
const palette = (list) => list.map(color);

const BRICK = palette(['#8e4b3b', '#7d4434', '#9b5a45', '#6b4a3a', '#a0644c', '#5e4339', '#b07a5e', '#874f3f']);
const PAINTED = palette(['#c8b9a4', '#d6ccb8', '#a9a39a', '#9aa3a8', '#bfae94', '#e0d8c8', '#8d8a85']);
const GLASS = palette(['#6f8496', '#5d6e7e', '#7d93a3', '#4d5d6c', '#8a9daa', '#6b7f7a', '#95a3ad']);
const ROOF = palette(['#4a4a4c', '#555352', '#5f5d5a', '#3f4042', '#6a6865', '#7b7a76']);
const PLAIN = palette(['#8d8780', '#9c958c', '#7b766f']);

function facadeColor(b, i, style) {
  if (b.fc && /^#[0-9a-f]{6}$/i.test(b.fc)) return color(b.fc);
  const r = hash01(i * 7 + 3);
  if (style === 'glass') return GLASS[Math.floor(r * GLASS.length)];
  if (style === 'plain') return PLAIN[Math.floor(r * PLAIN.length)];
  // Taller masonry buildings skew towards painted/precast; rowhouses towards brick.
  const brickChance = b.h < 16 ? 0.72 : 0.35;
  const list = hash01(i * 13 + 1) < brickChance ? BRICK : PAINTED;
  return list[Math.floor(r * list.length)];
}

function styleOf(b) {
  const h = b.h - (b.mh || 0);
  if (h <= 4.5 || ['roof', 'shed', 'garage', 'garages', 'carport'].includes(b.c)) return 'plain';
  if (b.h >= 40) return 'glass';
  return 'masonry';
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
    const style = styleOf(b);
    const col = facadeColor(b, i, style);
    const buf = bufs[style];
    // Offset the vertical texture phase a little per building so floors don't line up.
    const vOff = style === 'glass' ? 0 : hash01(i) * 0.08;
    for (const ring of [outer, ...holes]) {
      for (let k = 0; k < ring.length; k++) {
        const a = ring[k], c = ring[(k + 1) % ring.length];
        const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
        if (len < 0.05) continue;
        // Whole number of bays per facade so windows are never sliced at corners.
        const bays = len < 2 ? 0 : Math.max(1, Math.round(len / BAY_M));
        const u1 = bays ? bays / TILE : 0.02;
        buf.wall(a, c, bot, top, col, bays ? 0 : 0.02, u1, bot / (FLOOR_M * TILE) - vOff, top / (FLOOR_M * TILE) - vOff);
      }
    }
    const rc = ROOF[Math.floor(hash01(i * 31 + 5) * ROOF.length)];
    try {
      capPolygon(bufs.roof, outer, holes, top, rc);
    } catch {
      /* degenerate footprint */
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

// Flat filled polygons (land, parks, plazas...) with a colour per kind.
export function buildFlatAreas(list, y, colorOf) {
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
  const mesh = new THREE.Mesh(buf.toGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
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
    for (let k = 0; k < outer.length; k++) walls.wall(outer[k], outer[(k + 1) % outer.length], 0, a.emb, stone);
    try {
      capPolygon(top, outer, [], a.emb, green);
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

// Vertical bulkhead along every land edge that meets the river.
export function buildSeawall(land, top = 0.02) {
  const buf = new GeoBuffer();
  const col = color('#6d6961');
  for (const l of land) {
    const rings = [orient(toPts(l.o), true), ...(l.holes || []).map((h) => orient(toPts(h), false))];
    for (const ring of rings)
      for (let k = 0; k < ring.length; k++) {
        const a = ring[k], b = ring[(k + 1) % ring.length];
        if (Math.max(Math.abs(a[0]), Math.abs(a[1]), Math.abs(b[0]), Math.abs(b[1])) > 29000) continue;
        buf.wall(a, b, WATER_Y - 2, top, col);
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
        deck.wall(right[i], right[i + 1], Math.max(0, y0 - t), y0 + 0.9, deckCol);
        deck.wall(left[i + 1], left[i], Math.max(0, y1 - t), y1 + 0.9, deckCol);
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
  const surface = new THREE.Mesh(buf.toGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
  surface.receiveShadow = true;
  surface.castShadow = !!elevated;
  group.add(surface);
  if (deck.count) {
    const m = new THREE.Mesh(deck.toGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide }));
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
      m4.setPosition(e, 0, -n);
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
  const mesh = new THREE.Mesh(buf.toGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }));
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
  mesh.position.y = WATER_Y;
  mesh.receiveShadow = true;
  mesh.name = 'water';
  // Drift the ripples with the tide.
  mesh.userData.update = (t) => normalMap.offset.set(t * 0.012, t * 0.007);
  return mesh;
}
