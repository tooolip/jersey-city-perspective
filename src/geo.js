// 2D geometry helpers. All coordinates are [east, north] meters; three.js space is
// x = east, y = up, z = -north.

export function toPts(flat) {
  const pts = [];
  for (let i = 0; i < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
  return pts;
}

export function signedArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  return a / 2; // > 0 when counter-clockwise
}

export function orient(ring, ccw) {
  return (signedArea(ring) > 0) === ccw ? ring : ring.slice().reverse();
}

export function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distToSeg(x, y, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

// Distance to a ring's edges (ring is implicitly closed).
export function distToRing(x, y, ring) {
  let d = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const v = distToSeg(x, y, ring[j][0], ring[j][1], ring[i][0], ring[i][1]);
    if (v < d) d = v;
  }
  return d;
}

export function bbox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

// Uniform spatial hash for fast nearby lookups.
export class Grid {
  constructor(cell = 50) {
    this.cell = cell;
    this.cells = new Map();
  }
  insert(item, [x0, y0, x1, y1]) {
    const c = this.cell;
    for (let gx = Math.floor(x0 / c); gx <= Math.floor(x1 / c); gx++)
      for (let gy = Math.floor(y0 / c); gy <= Math.floor(y1 / c); gy++) {
        const k = gx * 100003 + gy;
        let list = this.cells.get(k);
        if (!list) this.cells.set(k, (list = []));
        list.push(item);
      }
  }
  query(x, y) {
    const c = this.cell;
    return this.cells.get(Math.floor(x / c) * 100003 + Math.floor(y / c)) || EMPTY;
  }
}
const EMPTY = [];

// Deterministic pseudo-random in [0, 1) from an integer.
export function hash01(n) {
  let h = (n | 0) * 374761393 + 668265263;
  h = (h ^ (h >>> 13)) * 1274126177;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
