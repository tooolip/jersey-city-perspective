// Samples each building's roof colour from the NAIP aerial photo (data/raw/naip.rgb, a raw
// RGB dump in lon/lat produced by scripts/fetch-imagery.py).
import { readFile } from 'node:fs/promises';
import { pointInRing, distToRing, toPts } from './geom.mjs';

export async function loadImagery(dir = 'data/raw') {
  try {
    const meta = JSON.parse(await readFile(`${dir}/naip.json`, 'utf8'));
    const rgb = await readFile(`${dir}/naip.rgb`);
    return { ...meta, rgb };
  } catch {
    return null;
  }
}

const hex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

// unproj: [east, north] -> [lon, lat]
export function sampleRoofColours(buildings, img, unproj) {
  const [lon0, lat0, lon1, lat1] = img.bbox;
  const toPx = ([e, n]) => {
    const [lon, lat] = unproj(e, n);
    return [((lon - lon0) / (lon1 - lon0)) * img.width, ((lat1 - lat) / (lat1 - lat0)) * img.height];
  };
  let sampled = 0;
  for (const b of buildings) {
    const ring = toPts(b.o).map(toPx);
    const holes = (b.holes || []).map((h) => toPts(h).map(toPx));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of ring) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    if (x0 < 0 || y0 < 0 || x1 >= img.width || y1 >= img.height) continue;
    const area = (x1 - x0) * (y1 - y0);
    const stride = Math.max(1, Math.round(Math.sqrt(area / 3000)));
    const closed = [...ring, ring[0]];
    const rs = [], gs = [], bs = [];
    let total = 0;
    for (let y = Math.ceil(y0); y <= y1; y += stride)
      for (let x = Math.ceil(x0); x <= x1; x += stride) {
        const p = [x + 0.5, y + 0.5];
        if (!pointInRing(p, ring) || holes.some((h) => pointInRing(p, h))) continue;
        // Stay ~0.6 m inside the outline to skip parapets, gutters and misregistration.
        if (distToRing(p, closed) < 2) continue;
        total++;
        const i = (y * img.width + x) * 3;
        const r = img.rgb[i], g = img.rgb[i + 1], bl = img.rgb[i + 2];
        if (g > r + 10 && g > bl + 4) continue; // overhanging tree canopy
        if (r + g + bl < 45) continue; // deep shadow
        rs.push(r); gs.push(g); bs.push(bl);
      }
    if (rs.length < 8 || rs.length < total * 0.3) continue;
    const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
    b.rc = hex(med(rs), med(gs), med(bs));
    sampled++;
  }
  return sampled;
}
