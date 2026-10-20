// Street furniture at real positions. Mapillary detections (triangulated from street-level
// photos, mostly 2018-2019 here, some 2026) are the main source; OSM fills in what Mapillary
// doesn't detect (bus stops, Citi Bike docks, PATH entrances, mapped benches/hydrants).
import { pointInRing, distToSeg, toPts, Grid, bbox } from './geom.mjs';

// Mapillary object_value -> furniture kind. Anything unlisted (ads, cones, temporary barriers,
// banners, CCTV...) is dropped as transient or not useful.
const MLY_OBJECTS = {
  'object--street-light': 'lamp',
  'object--support--utility-pole': 'pole',
  'object--traffic-light--general-upright': 'signal',
  'object--traffic-light--general-upright-front': 'signal',
  'object--traffic-light--general-upright-side': 'signal',
  'object--traffic-light--general-upright-back': 'signal',
  'object--traffic-light--general-horizontal': 'signal',
  'object--traffic-light--general-horizontal-front': 'signal',
  'object--traffic-light--general-horizontal-side': 'signal',
  'object--traffic-light--general-single': 'signal',
  'object--traffic-light--general-single-front': 'signal',
  'object--traffic-light--pedestrians': 'pedsignal',
  'object--traffic-light--pedestrians-front': 'pedsignal',
  'object--traffic-light--pedestrians-side': 'pedsignal',
  'object--traffic-light--pedestrians-back': 'pedsignal',
  'object--fire-hydrant': 'hydrant',
  'object--trash-can': 'trash',
  'object--bench': 'bench',
  'object--bike-rack': 'bikerack',
  'object--junction-box': 'cabinet',
  'object--mailbox': 'mailbox',
  'object--parking-meter': 'meter',
  'object--phone-booth': 'phone',
  'object--manhole': 'manhole',
  'object--catch-basin': 'drain',
  'marking--discrete--stop-line': 'stopline',
  'marking--discrete--arrow--left': 'arrow',
  'marking--discrete--arrow--right': 'arrow',
  'marking--discrete--arrow--straight': 'arrow',
  'marking--discrete--arrow--split-right-or-straight': 'arrow',
  'marking--discrete--arrow--split-left-or-straight': 'arrow',
  'marking--discrete--symbol--bicycle': 'bikesymbol',
};
const SIGN_PREFIX = /^(regulatory|warning|information|complementary)--/;
const ON_ROAD = new Set(['manhole', 'stopline', 'arrow', 'bikesymbol']);
// Merge radius for duplicate detections of the same object.
const MERGE_M = { lamp: 3, pole: 2.5, signal: 2, pedsignal: 2, hydrant: 3, trash: 2, bench: 2, cabinet: 2, manhole: 1.5, drain: 2, stopline: 4, arrow: 3, bikesymbol: 3, sign: 1.2 };

const OSM_KINDS = (t) => {
  if (t.highway === 'bus_stop') return t.shelter === 'yes' ? 'shelter' : 'busstop';
  if (t.amenity === 'bicycle_rental') return 'bikeshare';
  if (t.amenity === 'bench') return 'bench';
  if (t.amenity === 'waste_basket') return 'trash';
  if (t.amenity === 'bicycle_parking') return 'bikerack';
  if (t.amenity === 'post_box') return 'mailbox';
  if (t.amenity === 'drinking_water') return 'fountain';
  if (t.emergency === 'fire_hydrant') return 'hydrant';
  if (t.barrier === 'bollard') return 'bollard';
  if (t.railway === 'subway_entrance') return 'pathentrance';
  if (t.highway === 'street_lamp') return 'lamp';
  return null;
};

export function buildStreetFurniture({ mapillary, osmPois, proj, inScope, buildings, roads }) {
  // Spatial indexes for snapping objects onto sidewalks.
  const bGrid = new Grid(40);
  for (const b of buildings) {
    if ((b.mh || 0) > 2) continue;
    const ring = toPts(b.o);
    const bb = bbox(ring);
    bGrid.insertBox(ring, bb[0], bb[1], bb[2], bb[3]);
  }
  const rGrid = new Grid(30);
  for (const r of roads) {
    if (r.e) continue;
    const pts = toPts(r.p);
    for (let i = 0; i < pts.length - 1; i++) {
      const s = { a: pts[i], b: pts[i + 1], hw: r.w / 2, k: r.k };
      rGrid.insertBox(s, Math.min(s.a[0], s.b[0]) - s.hw - 2, Math.min(s.a[1], s.b[1]) - s.hw - 2, Math.max(s.a[0], s.b[0]) + s.hw + 2, Math.max(s.a[1], s.b[1]) + s.hw + 2);
    }
  }
  // Carriageways only (sidewalk lines don't count), with per-side curb offsets where measured.
  const cGrid = new Grid(30);
  for (const r of roads) {
    if (r.e || /foot|path|pedestrian|steps|cycleway|corridor/.test(r.k)) continue;
    const pts = toPts(r.p);
    const hl = r.wl ?? r.w / 2, hr = r.wr ?? r.w / 2;
    for (let i = 0; i < pts.length - 1; i++) {
      const s = { a: pts[i], b: pts[i + 1], hl, hr };
      const m = Math.max(hl, hr) + 2;
      cGrid.insertBox(s, Math.min(s.a[0], s.b[0]) - m, Math.min(s.a[1], s.b[1]) - m, Math.max(s.a[0], s.b[0]) + m, Math.max(s.a[1], s.b[1]) + m);
    }
  }
  const nearestRoad = (p) => {
    let best = null, bd = Infinity;
    for (const s of rGrid.query(p[0], p[1])) {
      const d = distToSeg(p, s.a, s.b);
      if (d < bd) { bd = d; best = s; }
    }
    return best && { s: best, d: bd };
  };
  const project = (p, s) => {
    const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1], l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - s.a[0]) * dx + (p[1] - s.a[1]) * dy) / l2));
    return [s.a[0] + t * dx, s.a[1] + t * dy];
  };
  // Photo triangulation is good to a few metres; push objects out of buildings and carriageways.
  const snap = (p) => {
    let q = p;
    for (const ring of bGrid.query(q[0], q[1])) {
      if (!pointInRing(q, ring)) continue;
      let best = null, bd = Infinity;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const c = project(q, { a: ring[j], b: ring[i] });
        const d = Math.hypot(c[0] - q[0], c[1] - q[1]);
        if (d < bd) { bd = d; best = c; }
      }
      if (best && bd < 6) {
        const l = bd || 1;
        q = [best[0] + ((best[0] - q[0]) / l) * 0.5, best[1] + ((best[1] - q[1]) / l) * 0.5];
      }
      break;
    }
    // Out of every carriageway the point falls in (twice over for intersections: out of one
    // road, then out of the cross street, which leaves it on the corner).
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      for (const s of cGrid.query(q[0], q[1])) {
        const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1], L = Math.hypot(dx, dy) || 1;
        const t = ((q[0] - s.a[0]) * dx + (q[1] - s.a[1]) * dy) / (L * L);
        if (t < -0.02 || t > 1.02) continue;
        const lat = (dx * (q[1] - s.a[1]) - dy * (q[0] - s.a[0])) / L; // + = left of a->b
        if (lat > -s.hr - 0.35 && lat < s.hl + 0.35) {
          const target = lat >= 0 ? s.hl + 0.6 : -(s.hr + 0.6);
          q = [q[0] - (dy / L) * (target - lat), q[1] + (dx / L) * (target - lat)];
          moved = true;
        }
      }
      if (!moved) break;
    }
    return q;
  };
  const roadBearing = (p) => {
    const nr = nearestRoad(p);
    if (!nr) return null;
    const { a, b } = nr.s;
    return { deg: (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI, s: nr.s, d: nr.d };
  };

  const items = [];
  const merged = new Grid(8);
  const add = (it, mergeR) => {
    if (mergeR && merged.query(it.x, it.y).some((o) => o.k === it.k && o.v === it.v && Math.hypot(o.x - it.x, o.y - it.y) < mergeR)) return false;
    merged.insertBox(it, it.x - 8, it.y - 8, it.x + 8, it.y + 8);
    items.push(it);
    return true;
  };
  const r1 = (v) => Math.round(v * 10) / 10;

  let fromMly = 0;
  for (const f of mapillary) {
    const val = f.object_value;
    const kind = SIGN_PREFIX.test(val) ? 'sign' : val === 'object--traffic-sign--front' ? 'sign' : MLY_OBJECTS[val];
    if (!kind) continue;
    const raw = proj(...f.geometry.coordinates);
    if (!inScope(raw)) continue;
    const yr = parseInt((f.last_seen_at || '').slice(0, 4), 10) || undefined;
    let p = raw, d = f.aligned_direction ?? null;
    if (ON_ROAD.has(kind)) {
      const rb = roadBearing(raw);
      if (!rb || rb.d > rb.s.hw + 1) continue;
      // Markings read along the road; pick the travel direction closest to the detection's.
      d = rb.deg;
      if (f.aligned_direction != null && Math.abs(((f.aligned_direction - d + 540) % 360) - 180) < 90) d += 180;
      if (kind === 'stopline') {
        // Stop line spans from the centreline to the curb on the side it was seen.
        const c = project(raw, rb.s);
        p = c;
        const side = Math.sign((rb.s.b[0] - rb.s.a[0]) * (raw[1] - rb.s.a[1]) - (rb.s.b[1] - rb.s.a[1]) * (raw[0] - rb.s.a[0])) || 1;
        const it = { k: kind, x: r1(c[0]), y: r1(c[1]), d: Math.round(rb.deg), w: r1(rb.s.hw), side, s: 'mly', yr };
        if (add(it, MERGE_M.stopline)) fromMly++;
        continue;
      }
    } else {
      p = snap(raw);
      if (kind === 'lamp' || kind === 'pole' || kind === 'drain') {
        // Lamp arms and pole crossarms point at the street; the photo direction says nothing useful.
        const nr = nearestRoad(p);
        if (nr) {
          const c = project(p, nr.s);
          d = (Math.atan2(c[0] - p[0], c[1] - p[1]) * 180) / Math.PI;
        }
      }
    }
    const it = { k: kind, x: r1(p[0]), y: r1(p[1]), s: 'mly', yr };
    if (d !== null) it.d = Math.round(d);
    if (kind === 'sign' || kind === 'arrow') it.v = val.replace(/^(marking--discrete--arrow--)/, '');
    if (add(it, MERGE_M[kind] || 2)) fromMly++;
  }

  let fromOsm = 0;
  for (const e of osmPois) {
    const t = e.tags || {};
    const kind = OSM_KINDS(t);
    if (!kind) continue;
    const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
    if (lat === undefined) continue;
    const raw = proj(lon, lat);
    if (!inScope(raw)) continue;
    // Prefer the photo-detected object when both sources have it.
    if (merged.query(raw[0], raw[1]).some((o) => o.k === kind && Math.hypot(o.x - raw[0], o.y - raw[1]) < 10)) continue;
    const p = kind === 'pathentrance' ? raw : snap(raw);
    const it = { k: kind, x: r1(p[0]), y: r1(p[1]), s: 'osm' };
    const rb = roadBearing(p);
    if (rb) it.d = Math.round(rb.deg); // align with the street
    if (t.name) it.n = t.name;
    if (kind === 'bikeshare' && t.capacity) it.cap = parseInt(t.capacity, 10) || undefined;
    if (kind === 'busstop' || kind === 'shelter') it.n = t.name || t.ref;
    if (add(it, 0)) fromOsm++;
  }

  // Signs within ~1 m of each other share one post: give them a common post position.
  const signs = items.filter((i) => i.k === 'sign');
  const postGrid = new Grid(4);
  let posts = 0;
  for (const s of signs) {
    const host = postGrid.query(s.x, s.y).find((p) => Math.hypot(p.x - s.x, p.y - s.y) < 1.1 && p.n < 4);
    if (host) {
      s.post = host.id;
      s.slot = host.n++;
      s.x = host.x;
      s.y = host.y;
    } else {
      const post = { id: posts++, x: s.x, y: s.y, n: 1 };
      postGrid.insertBox(post, s.x - 2, s.y - 2, s.x + 2, s.y + 2);
      s.post = post.id;
      s.slot = 0;
    }
  }
  return { items, fromMly, fromOsm, posts };
}
