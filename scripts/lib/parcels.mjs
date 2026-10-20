// Joins building footprints to NJ tax parcels (MOD-IV) for storeys, year built, construction
// and address. MOD-IV building descriptions are assessor shorthand, e.g. "3S-BT-B-D-3U-H":
// the storey count ("3S") and units ("3U") are reliable; material letters are inferred.
import { pointInRing, toPts, bbox, Grid, ringArea } from './geom.mjs';

export const PROP_CLASS = {
  1: 'Vacant land', 2: 'Residential (1–4 units)', '3A': 'Farm', '3B': 'Farm', '4A': 'Commercial',
  '4B': 'Industrial', '4C': 'Apartments (5+ units)', '5A': 'Railroad', '5B': 'Railroad',
  '15A': 'Public school', '15B': 'Other school', '15C': 'Public property', '15D': 'Church / charitable',
  '15E': 'Cemetery', '15F': 'Other exempt',
};

const MATERIAL_TOKENS = {
  B: 'brick', BR: 'brick', BRK: 'brick', BD: 'brick', BT: null,
  F: 'frame', FR: 'frame', FD: 'frame',
  C: 'concrete', RC: 'concrete', CB: 'concrete block', CONC: 'concrete', BLK: 'concrete block',
  ST: 'stone', STN: 'stone', STU: 'stucco', STUC: 'stucco',
  AL: 'aluminum siding', AS: 'aluminum siding', VS: 'vinyl siding', V: 'vinyl siding',
  STL: 'steel', G: null, M: 'masonry', MAS: 'masonry',
};

export function parseBldgDesc(desc) {
  if (!desc) return {};
  const d = desc.toUpperCase().trim();
  const out = {};
  const st = /^(\d+(?:\.\d+)?)\s*S/.exec(d);
  if (st) out.storeys = parseFloat(st[1]);
  const u = /(\d+)\s*U/.exec(d);
  if (u) out.units = parseInt(u[1], 10);
  // Trailing garage descriptors ("-B-G", "-FG", "BG") describe an outbuilding, not the house.
  const body = d.replace(/[-\s]?(B|F)-?G$/, '').replace(/^(\d+(?:\.\d+)?)\s*S/, '');
  const mats = new Set();
  for (const tok of body.split(/[-&\s]+/)) {
    const m = MATERIAL_TOKENS[tok];
    if (m) mats.add(m);
  }
  if (/B&F/.test(d)) { mats.add('brick'); mats.add('frame'); }
  if (mats.size) out.material = [...mats].join(' + ');
  return out;
}

export function loadParcels(geojson, proj) {
  // Condo units repeat the same lot polygon; collapse them into one parcel.
  const byShape = new Map();
  for (const f of geojson.features) {
    if (!f.geometry) continue;
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    const key = JSON.stringify(polys[0][0].slice(0, 4));
    const a = f.properties;
    let p = byShape.get(key);
    if (!p) {
      p = { rings: polys.map((poly) => poly[0].map(([lon, lat]) => proj(lon, lat))), records: [] };
      byShape.set(key, p);
    }
    p.records.push(a);
  }
  const parcels = [];
  for (const p of byShape.values()) {
    const recs = p.records;
    const parsed = recs.map((r) => ({ r, ...parseBldgDesc(r.BLDG_DESC) }));
    const best = parsed.find((x) => x.storeys) || parsed[0];
    const years = recs.map((r) => r.YR_CONSTR).filter((y) => y && y > 1700 && y < 2030);
    const units = Math.max(0, ...parsed.map((x) => x.units || 0));
    const area = p.rings.reduce((s, r) => s + Math.abs(ringArea(r)), 0);
    parcels.push({
      rings: p.rings,
      area,
      addr: titleCase(best.r.PROP_LOC),
      block: best.r.PCLBLOCK,
      lot: best.r.PCLLOT,
      cls: best.r.PROP_CLASS,
      desc: best.r.BLDG_DESC,
      storeys: best.storeys,
      material: best.material,
      units: units || undefined,
      condo: recs.length > 1 || /CONDO|COND/.test(best.r.BLDG_DESC || '') || undefined,
      year: years.length ? mode(years) : undefined,
      lotSize: best.r.LAND_DESC || undefined,
      facility: best.r.FAC_NAME || undefined,
    });
  }
  const grid = new Grid(30);
  for (const p of parcels) for (const r of p.rings) { const bb = bbox(r); grid.insertBox(p, bb[0], bb[1], bb[2], bb[3]); }
  return { parcels, grid };
}

// Vote with sample points inside the footprint so large buildings spanning several lots pick
// the lot that holds most of the building.
export function joinBuildingsToParcels(buildings, { grid }) {
  let joined = 0;
  for (const b of buildings) {
    const ring = toPts(b.o);
    const [x0, y0, x1, y1] = bbox(ring);
    const votes = new Map();
    const n = 5;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const p = [x0 + ((i + 0.5) / n) * (x1 - x0), y0 + ((j + 0.5) / n) * (y1 - y0)];
        if (!pointInRing(p, ring)) continue;
        // Smallest containing lot wins where lots overlap (condo common areas, etc.).
        let hit = null;
        for (const pc of grid.query(p[0], p[1])) if (pc.rings.some((r) => pointInRing(p, r)) && (!hit || pc.area < hit.area)) hit = pc;
        if (hit) votes.set(hit, (votes.get(hit) || 0) + 1);
      }
    if (!votes.size) continue;
    const parcel = [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
    joined++;
    const rec = { addr: parcel.addr, bl: `${parcel.block}/${parcel.lot}`, cls: parcel.cls };
    for (const k of ['storeys', 'material', 'units', 'condo', 'year', 'lotSize', 'facility', 'desc']) if (parcel[k] !== undefined) rec[k] = parcel[k];
    b.tax = rec;
    // A measured height beats the assessor; an estimated one doesn't.
    if (b.est && parcel.storeys && !['shed', 'garage', 'garages', 'roof', 'carport'].includes(b.c)) {
      // 3.75 m per storey + parapet matches the median of LiDAR-measured buildings here.
      b.h = Math.round((parcel.storeys * 3.75 + 0.6) * 10) / 10;
      b.est = 'storeys';
    }
  }
  return joined;
}

function mode(list) {
  const c = new Map();
  for (const v of list) c.set(v, (c.get(v) || 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
}

function titleCase(s) {
  if (!s) return undefined;
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\s+/g, ' ').trim();
}
