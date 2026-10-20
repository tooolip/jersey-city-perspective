// Loads LiDAR products from scripts/process-lidar.py and turns the 1 m ground model into the
// scene's terrain grid (Int16 centimetres, NAVD88 ≈ mean sea level).
import { readFile } from 'node:fs/promises';
import { toPts } from './geom.mjs';

export async function loadLidar(dir = 'data/derived') {
  try {
    const meta = JSON.parse(await readFile(`${dir}/dtm.json`, 'utf8'));
    const buf = await readFile(`${dir}/dtm.f32`);
    const data = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    const sbuf = await readFile(`${dir}/surface_low.f32`);
    const surface = new Float32Array(sbuf.buffer, sbuf.byteOffset, sbuf.byteLength / 4);
    const trees = JSON.parse(await readFile(`${dir}/trees.json`, 'utf8'));
    const roofs = JSON.parse(await readFile(`${dir}/roofs.json`, 'utf8'));
    return { dtm: { ...meta, data, surface }, trees, roofs };
  } catch {
    return null;
  }
}

// Scanline fill of polygons (rings in [east, north]) onto a grid of vertex samples.
function rasterize(rings, grid, setter) {
  const { e0, n1, res, w, h } = grid;
  for (const ring of rings) {
    let y0 = Infinity, y1 = -Infinity;
    for (const p of ring) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    const r0 = Math.max(0, Math.floor((n1 - y1) / res)), r1 = Math.min(h - 1, Math.ceil((n1 - y0) / res));
    for (let r = r0; r <= r1; r++) {
      const y = n1 - r * res;
      const xs = [];
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y)) xs.push(xi + ((y - yi) / (yj - yi)) * (xj - xi));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil((xs[k] - e0) / res)), c1 = Math.min(w - 1, Math.floor((xs[k + 1] - e0) / res));
        for (let c = c0; c <= c1; c++) setter(r * w + c);
      }
    }
  }
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

/**
 * dtm: 1 m grid from process-lidar. Returns a coarser grid of vertex samples for the client:
 * embankment blocks flattened to the surrounding street level (their real height is returned
 * separately), edges faded to `fallback` so the terrain meets the flat ground beyond it.
 * `bed` is the river-bed depth the client uses for bulkhead walls.
 */
export function buildTerrain(dtm, { embankments, res = 3, bed = -3, fallback = 2.5, fadeM = 80 }) {
  const step = Math.round(res / dtm.res);
  const w = Math.floor(dtm.w / step), h = Math.floor(dtm.h / step);
  const grid = { e0: dtm.e0 + (step * dtm.res) / 2, n1: dtm.n1 - (step * dtm.res) / 2, res, w, h };
  const v = new Float32Array(w * h);
  for (let r = 0; r < h; r++)
    for (let c = 0; c < w; c++) {
      let s = 0;
      for (let dr = 0; dr < step; dr++) for (let dc = 0; dc < step; dc++) s += dtm.data[(r * step + dr) * dtm.w + c * step + dc];
      v[r * w + c] = s / (step * step);
    }
  const raw = v.slice();

  // Embankments: replace with an interpolation of the surrounding street level.
  const embHeights = [];
  for (const a of embankments) {
    const inside = [];
    rasterize([toPts(a.o)], grid, (i) => inside.push(i));
    if (!inside.length) { embHeights.push(null); continue; }
    const unknown = new Set(inside);
    while (unknown.size) {
      const next = [];
      for (const i of unknown) {
        const r = Math.floor(i / w), c = i % w;
        let s = 0, n = 0;
        for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || rr >= h || cc < 0 || cc >= w) continue;
          const j = rr * w + cc;
          if (!unknown.has(j)) { s += v[j]; n++; }
        }
        if (n) next.push([i, s / n]);
      }
      if (!next.length) break;
      for (const [i, val] of next) { v[i] = val; unknown.delete(i); }
    }
    // Top = 30th percentile of the 1 m top surface inside (the ground filter often rejects the deck;
    // lower percentiles catch street-level pixels along the outline).
    const tops = [];
    rasterize([toPts(a.o)], { e0: dtm.e0 + 0.5, n1: dtm.n1 - 0.5, res: dtm.res, w: dtm.w, h: dtm.h }, (i) => tops.push(dtm.surface[i]));
    tops.sort((x, y) => x - y);
    const top = tops.length ? tops[Math.floor(tops.length * 0.3)] : median(inside.map((i) => raw[i]));
    const height = top - median(inside.map((i) => v[i]));
    embHeights.push(height < 1.5 ? 0 : Math.round(Math.min(10, height) * 10) / 10);
  }

  // Over open water the grid keeps the nearest shore height (filled in process-lidar), so ground
  // sampled right at the shoreline is land height; the client draws the river and bulkheads.
  // Fade to the flat fallback ground near the edges of the LiDAR extent.
  for (let r = 0; r < h; r++)
    for (let c = 0; c < w; c++) {
      const d = Math.min(r, c, h - 1 - r, w - 1 - c) * res;
      if (d >= fadeM) continue;
      const t = d / fadeM, s = t * t * (3 - 2 * t);
      const i = r * w + c;
      v[i] = fallback + (v[i] - fallback) * s;
    }

  const cm = new Int16Array(w * h);
  for (let i = 0; i < v.length; i++) cm[i] = Math.round(v[i] * 100);
  const extent = [grid.e0, grid.n1 - (h - 1) * res, grid.e0 + (w - 1) * res, grid.n1];
  return { grid: { ...grid, fallback, bed, extent }, cm, embHeights };
}
