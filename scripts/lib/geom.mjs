// Shared 2D geometry helpers for the data build. Points are [east, north] meters.

export function segIntersect(a, b, c, d) {
  const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { t, u, p: [a[0] + t * r[0], a[1] + t * r[1]] } : null;
}

export function pointInRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distToSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

export function distToRing(p, ring) {
  let d = Infinity;
  for (let i = 0; i < ring.length - 1; i++) d = Math.min(d, distToSeg(p, ring[i], ring[i + 1]));
  return d;
}

export const toPts = (flat) => { const r = []; for (let i = 0; i < flat.length; i += 2) r.push([flat[i], flat[i + 1]]); return r; };
export const bbox = (pts) => pts.reduce((b, p) => [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])], [Infinity, Infinity, -Infinity, -Infinity]);

export const centroid = (ring) => {
  let x = 0, y = 0;
  for (const p of ring) { x += p[0]; y += p[1]; }
  return [x / ring.length, y / ring.length];
};

export const ringArea = (ring) => {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return a / 2;
};

// Drop closing duplicate + consecutive duplicates.
export function openRing(ring) {
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
export function assembleRings(lines) {
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

// Uniform spatial hash.
export class Grid {
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
