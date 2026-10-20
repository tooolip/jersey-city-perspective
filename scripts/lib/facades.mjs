// Facade kits and per-building facade facts: which edges face a street, which kit (era/type)
// the building gets, bay counts from the recorded lot frontage, inferred stoops and cornices,
// storefront ground floors, and measured facade colours from street photos.
import { pointInRing, distToSeg, toPts, Grid, bbox } from './geom.mjs';

// Kit names map to rows of the facade atlas in src/facade-atlas.js.
export function classifyKit(b) {
  const t = b.tax || {};
  const yr = t.year, st = t.storeys || Math.round(b.h / 3.75);
  const mat = t.material || '';
  const area = footprintArea(b);
  if (b.h <= 4.5 || ['roof', 'shed', 'garage', 'garages', 'carport'].includes(b.c)) return null;
  if (b.h >= 40 || (yr >= 2000 && b.h >= 25)) return 'glass';
  if (yr >= 1990) return 'modern';
  if (yr >= 1940 && st >= 4) return 'midcentury';
  if (/^frame|siding/.test(mat)) return 'frame';
  if (t.cls === '4B' || (area > 1200 && st >= 3 && (!yr || yr < 1940))) return 'warehouse';
  if (!yr && st >= 6) return 'midcentury';
  return 'rowhouse';
}

export const KIT_LABEL = {
  rowhouse: 'Brick / brownstone rowhouse',
  frame: 'Frame house with siding',
  warehouse: 'Masonry warehouse / loft',
  midcentury: 'Mid-century apartment block',
  modern: 'Post-1990 mid-rise',
  glass: 'Curtain-wall tower',
};

// Window bay width per kit (m). Rowhouse bays come from lot frontage when known.
const BAY = { rowhouse: 2.1, frame: 2.3, warehouse: 4.2, midcentury: 3.2, modern: 3.0, glass: 1.6 };

function footprintArea(b) {
  const r = toPts(b.o);
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return Math.abs(a / 2);
}

const frontageM = (lotSize) => {
  const m = /^\s*([\d.]+)\s*X/i.exec(lotSize || '');
  return m ? parseFloat(m[1]) * 0.3048 : null;
};

export function annotateFacades(buildings, roads, { signs = [], photoColours = {} } = {}) {
  const bGrid = new Grid(40);
  const rings = buildings.map((b) => {
    const ring = toPts(b.o);
    let a = 0;
    for (let k = 0, j = ring.length - 1; k < ring.length; j = k++) a += (ring[j][0] - ring[k][0]) * (ring[j][1] + ring[k][1]);
    return { ring, ccw: a > 0 };
  });
  buildings.forEach((b, i) => {
    const bb = bbox(rings[i].ring);
    bGrid.insertBox(i, bb[0], bb[1], bb[2], bb[3]);
  });
  const rGrid = new Grid(30);
  for (const r of roads) {
    if (r.e || ['motorway', 'motorway_link', 'trunk_link', 'footway', 'path', 'steps', 'cycleway'].includes(r.k)) continue;
    const pts = toPts(r.p);
    for (let i = 0; i < pts.length - 1; i++) {
      const s = { a: pts[i], b: pts[i + 1], hw: r.w / 2 };
      rGrid.insertBox(s, Math.min(s.a[0], s.b[0]) - 20, Math.min(s.a[1], s.b[1]) - 20, Math.max(s.a[0], s.b[0]) + 20, Math.max(s.a[1], s.b[1]) + 20);
    }
  }
  const withSigns = new Set(signs.map((s) => s.b));
  const stats = { kits: {}, stoops: 0, cornices: 0, shops: 0, photo: 0 };

  buildings.forEach((b, i) => {
    const { ring, ccw } = rings[i];
    // Street-facing edges, indexed as in b.o (whatever its winding).
    const sf = [];
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k], c = ring[(k + 1) % ring.length];
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (len < 2) continue;
      let nx = (c[1] - a[1]) / len, ny = -(c[0] - a[0]) / len; // outward if CCW
      if (!ccw) { nx = -nx; ny = -ny; }
      const probe = [(a[0] + c[0]) / 2 + nx * 4, (a[1] + c[1]) / 2 + ny * 4];
      if (bGrid.query(probe[0], probe[1]).some((j) => j !== i && pointInRing(probe, rings[j].ring))) continue;
      if (rGrid.query(probe[0], probe[1]).some((s) => distToSeg(probe, s.a, s.b) - s.hw < 8)) sf.push(k);
    }
    const kit = classifyKit(b);
    if (!kit) return;
    b.kit = kit;
    stats.kits[kit] = (stats.kits[kit] || 0) + 1;
    if (sf.length) b.sf = sf;

    // Bays: a rowhouse's frontage sets its window count (12-14 ft: 2 bays, ~20 ft: 3, 25+: 4).
    const front = frontageM(b.tax?.lotSize);
    if (kit === 'rowhouse' || kit === 'frame') {
      if (front && front < 12) b.bay = Math.round((front / (front < 4.6 ? 2 : front < 7 ? 3 : front < 9 ? 4 : Math.round(front / 2.2))) * 100) / 100;
      else b.bay = BAY[kit];
    } else b.bay = BAY[kit];

    // Storefront ground floor where businesses are mapped, or the parcel is commercial.
    if ((withSigns.has(i) || b.tax?.cls === '4A') && kit !== 'glass' && sf.length) { b.shop = 1; stats.shops++; }

    // Pre-war street facades carry a cornice.
    const yr = b.tax?.year;
    if (sf.length && ['rowhouse', 'frame', 'warehouse'].includes(kit) && (!yr || yr < 1940)) { b.cornice = 1; stats.cornices++; }

    // Brownstone / brick rowhouses of 1850-1910 typically have a stoop up to a raised parlour
    // floor. Inferred, not observed: one per house, on its main street facade.
    if (kit === 'rowhouse' && !b.shop && b.tax?.cls === '2' && yr && yr < 1910 && (b.tax.storeys || 0) >= 2.5 && sf.length) {
      const k = sf.reduce((best, e) => (edgeLen(ring, e) > edgeLen(ring, best) ? e : best), sf[0]);
      const len = edgeLen(ring, k);
      if (len >= 3.5 && len <= 12) {
        // Entrance bay at one end (side chosen by lot number parity, a stand-in for real data).
        const lotNum = parseInt(b.tax.bl?.split('/')[1], 10) || i;
        b.stoop = { e: k, t: lotNum % 2 ? 0.18 : 0.82 };
        stats.stoops++;
      }
    }

    // Photo colours: agreeing photos set the colour; a single photo only guides the palette
    // choice in the client (fcs.c); disagreeing photos are recorded but not used.
    const pc = photoColours[b.id];
    if (pc) {
      b.fcs = { n: pc.n, of: pc.of, yr: pc.yr, conf: pc.conf, c: pc.c };
      if (pc.conf === 'agree') { b.fc = pc.c; stats.photo++; }
      else if (pc.conf === 'single') stats.guided = (stats.guided || 0) + 1;
    }
  });
  return stats;
}

function edgeLen(ring, k) {
  const a = ring[k], c = ring[(k + 1) % ring.length];
  return Math.hypot(c[0] - a[0], c[1] - a[1]);
}
