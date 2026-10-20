import * as THREE from 'three';

// Ground elevation from the LiDAR terrain grid (metres above NAVD88 ≈ mean sea level).
// Without terrain data everything sits on a flat plane at 0 and the river is 1.6 m below.
export class Terrain {
  constructor(meta, cm) {
    this.meta = meta;
    this.cm = cm;
    this.flat = !meta;
    this.fallback = meta ? meta.fallback : 0;
    this.waterLevel = meta ? 0.2 : -1.6;
    this.bed = meta ? meta.bed : -3.6;
  }

  static async load(meta, baseUrl) {
    if (!meta) return new Terrain(null, null);
    const res = await fetch(`${baseUrl}data/${meta.file}`);
    if (!res.ok) return new Terrain(null, null);
    return new Terrain(meta, new Int16Array(await res.arrayBuffer()));
  }

  // Bilinear sample; `fallback` outside the grid.
  height(e, n) {
    if (this.flat) return 0;
    const { e0, n1, res, w, h } = this.meta;
    const fx = (e - e0) / res, fy = (n1 - n) / res;
    if (fx < 0 || fy < 0 || fx > w - 1 || fy > h - 1) return this.fallback;
    const c = Math.min(w - 2, Math.floor(fx)), r = Math.min(h - 2, Math.floor(fy));
    const tx = fx - c, ty = fy - r;
    const i = r * w + c;
    const a = this.cm[i], b = this.cm[i + 1], d = this.cm[i + w], f = this.cm[i + w + 1];
    return ((a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + f * tx) * ty) / 100;
  }
}

// Subdivide triangles (non-indexed, flat layers) so they can follow the terrain, then lift
// every vertex by the ground height. `attrs` maps attribute name -> { array, size }; position
// must be first. Vertices are handled as interleaved float runs for speed.
export function drape(attrs, terrain, maxEdge = 7) {
  if (terrain.flat) return attrs;
  const names = Object.keys(attrs);
  const sizes = names.map((n) => attrs[n].size);
  const S = sizes.reduce((a, b) => a + b, 0);
  const count = attrs.position.array.length / 3;
  const inter = new Float32Array(count * S);
  for (let v = 0; v < count; v++) {
    let o = v * S;
    names.forEach((n, k) => {
      const sz = sizes[k], src = attrs[n].array;
      for (let j = 0; j < sz; j++) inter[o++] = src[v * sz + j];
    });
  }
  const out = [];
  const max2 = maxEdge * maxEdge;
  const vtx = (t, k) => inter.subarray((t * 3 + k) * S, (t * 3 + k + 1) * S);
  const mid = (a, b) => { const m = new Float32Array(S); for (let j = 0; j < S; j++) m[j] = (a[j] + b[j]) / 2; return m; };
  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[2] - b[2]) ** 2;
  for (let t = 0; t < count / 3; t++) {
    const stack = [[vtx(t, 0), vtx(t, 1), vtx(t, 2)]];
    while (stack.length) {
      const [a, b, c] = stack.pop();
      const ab = d2(a, b), bc = d2(b, c), ca = d2(c, a);
      const m = Math.max(ab, bc, ca);
      if (m > max2) {
        if (m === ab) { const x = mid(a, b); stack.push([a, x, c], [x, b, c]); }
        else if (m === bc) { const x = mid(b, c); stack.push([b, x, a], [x, c, a]); }
        else { const x = mid(c, a); stack.push([c, x, b], [x, a, b]); }
        continue;
      }
      out.push(a, b, c);
    }
  }
  const res = {};
  names.forEach((n, k) => { res[n] = { array: new Float32Array(out.length * sizes[k]), size: sizes[k] }; });
  out.forEach((v, i) => {
    let o = 0;
    names.forEach((n, k) => {
      const sz = sizes[k], dst = res[n].array;
      for (let j = 0; j < sz; j++) dst[i * sz + j] = v[o++];
    });
  });
  const pos = res.position.array;
  for (let i = 0; i < pos.length; i += 3) pos[i + 1] += terrain.height(pos[i], -pos[i + 2]);
  return res;
}
