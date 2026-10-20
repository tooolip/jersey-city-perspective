// Storefront signs with real business names. OSM (curated, mapped on site) wins; Overture places
// fill in open, high-confidence, street-facing businesses. Each sign is mounted on the facade
// edge of the host building that faces a street, above the ground-floor glazing.
import { pointInRing, distToSeg, distToRing, toPts, Grid, bbox } from './geom.mjs';

const OSM_AMENITY = new Set([
  'restaurant', 'fast_food', 'cafe', 'bar', 'pub', 'bank', 'pharmacy', 'ice_cream', 'veterinary', 'cinema',
  'theatre', 'post_office', 'dentist', 'clinic', 'doctors', 'childcare', 'nightclub', 'library',
  'community_centre', 'bureau_de_change', 'money_transfer', 'arts_centre', 'car_rental', 'fuel',
]);

const OVERTURE_CATEGORIES = new Set([
  'restaurant', 'casual_eatery', 'fast_food_restaurant', 'coffee_shop', 'cafe', 'bar', 'lounge', 'brewery',
  'smoothie_juice_bar', 'non_alcoholic_beverage_venue', 'food_and_beverage_store', 'convenience_store',
  'fashion_and_apparel_store', 'personal_or_beauty_service', 'personal_care_and_beauty_store', 'gym',
  'fitness_studio', 'sport_or_fitness_facility', 'bank_or_credit_union', 'pharmacy_and_drug_store',
  'hardware_home_and_garden_store', 'electronics_store', 'flowers_and_gifts_store', 'second_hand_store',
  'books_music_and_video_store', 'sporting_goods_store', 'specialty_store', 'animal_and_pet_store',
  'laundry_service', 'dental_clinic', 'vision_or_eye_care_clinic', 'art_gallery', 'music_venue',
  'department_store', 'discount_store', 'arts_crafts_and_hobby_store', 'toys_and_games_store', 'hotel',
  'animal_or_pet_service', 'shipping_or_delivery_service', 'movie_theater', 'comedy_club', 'market',
]);

// Coarse sign families. Real sign colours aren't in any dataset yet, so styling is by kind.
export function signKind(tags) {
  const v = tags.amenity || tags.shop || tags.cat || tags.leisure || tags.tourism || tags.craft || '';
  if (/restaurant|eatery|fast_food|food_court|pizza/.test(v)) return 'food';
  if (/cafe|coffee|bakery|ice_cream|smoothie|beverage|juice|tea/.test(v)) return 'cafe';
  if (/bar|pub|lounge|brewery|nightclub|wine|alcohol|music_venue|comedy/.test(v)) return 'bar';
  if (/bank|credit|money|bureau/.test(v)) return 'bank';
  if (/beauty|hair|nail|barber|cosmetic|spa|massage|tattoo/.test(v)) return 'beauty';
  if (/pharmacy|chemist|dent|clinic|doctor|optician|eye|veterinary|medical/.test(v)) return 'health';
  if (/gym|fitness|sport/.test(v)) return 'fitness';
  if (/hotel|hostel/.test(v)) return 'hotel';
  return 'shop';
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// Name tokens without filler, so "Boots & Bones BBQ" and "Boots and Bones JC" match.
const FILLER = new Set(['the', 'and', 'of', 'a', 'jc', 'jersey', 'city', 'nj', 'downtown', 'inc', 'llc', 'co', 'corp',
  'restaurant', 'bar', 'cafe', 'bbq', 'grill', 'kitchen', 'shop', 'store', 'pizza', 'pizzeria', 'deli']);
const tokens = (s) => new Set(s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((t) => t && !FILLER.has(t)));
function sameBusiness(a, b) {
  if (norm(a).includes(norm(b)) || norm(b).includes(norm(a))) return true;
  const ta = tokens(a), tb = tokens(b);
  if (!ta.size || !tb.size) return false;
  let both = 0;
  for (const t of ta) if (tb.has(t)) both++;
  return both / (ta.size + tb.size - both) >= 0.5;
}

export function collectBusinesses(osmPois, places, proj) {
  const out = [];
  for (const e of osmPois) {
    const t = e.tags || {};
    if (!t.name) continue;
    const storefront = t.shop || (t.amenity && OSM_AMENITY.has(t.amenity)) || t.craft || t.tourism === 'hotel' ||
      ['fitness_centre', 'sports_centre'].includes(t.leisure);
    if (!storefront) continue;
    const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
    if (lat === undefined) continue;
    out.push({ name: t.name, p: proj(lon, lat), kind: signKind(t), src: 'osm', type: t.shop || t.amenity || t.craft || t.leisure || t.tourism });
  }
  const osmGrid = new Grid(60);
  for (const b of out) osmGrid.insertBox(b, b.p[0] - 60, b.p[1] - 60, b.p[0] + 60, b.p[1] + 60);
  const ovGrid = new Grid(30);
  for (const f of places) {
    const pr = f.properties;
    const name = pr.names?.primary;
    const cat = pr.basic_category;
    if (!name || !OVERTURE_CATEGORIES.has(cat)) continue;
    if (pr.operating_status === 'permanently_closed') continue;
    if ((pr.confidence ?? 0) < (pr.operating_status === 'open' ? 0.75 : 0.9)) continue;
    const p = proj(...f.geometry.coordinates);
    const n = norm(name);
    if (osmGrid.query(p[0], p[1]).some((o) => Math.hypot(o.p[0] - p[0], o.p[1] - p[1]) < 60 && sameBusiness(o.name, name))) continue;
    if (ovGrid.query(p[0], p[1]).some((o) => Math.hypot(o.p[0] - p[0], o.p[1] - p[1]) < 30 && sameBusiness(o.name, name))) continue;
    const b = { name, p, kind: signKind({ cat }), src: 'overture', type: cat, n };
    ovGrid.insertBox(b, p[0] - 30, p[1] - 30, p[0] + 30, p[1] + 30);
    out.push(b);
  }
  return out;
}

const LETTER_M = 0.3; // average glyph advance at ~0.5 m cap height

export function placeSigns(businesses, buildings, roads) {
  const bGrid = new Grid(40);
  buildings.forEach((b, i) => {
    const ring = toPts(b.o);
    // Counter-clockwise so the outward normal of edge a->b is (dy, -dx).
    let area = 0;
    for (let k = 0, j = ring.length - 1; k < ring.length; j = k++) area += (ring[j][0] - ring[k][0]) * (ring[j][1] + ring[k][1]);
    const ccw = area > 0 ? ring : ring.slice().reverse();
    const bb = bbox(ring);
    bGrid.insertBox({ i, b, ring: ccw, bb }, bb[0] - 15, bb[1] - 15, bb[2] + 15, bb[3] + 15);
  });
  const rGrid = new Grid(30);
  for (const r of roads) {
    if (r.e || ['motorway', 'motorway_link', 'trunk_link'].includes(r.k)) continue;
    const pts = toPts(r.p);
    for (let i = 0; i < pts.length - 1; i++) {
      const s = { a: pts[i], b: pts[i + 1], hw: r.w / 2, name: r.n };
      rGrid.insertBox(s, Math.min(s.a[0], s.b[0]) - 20, Math.min(s.a[1], s.b[1]) - 20, Math.max(s.a[0], s.b[0]) + 20, Math.max(s.a[1], s.b[1]) + 20);
    }
  }
  const nearRoad = (p, within) => rGrid.query(p[0], p[1]).find((s) => distToSeg(p, s.a, s.b) - s.hw < within);
  const inOtherBuilding = (p, self) => bGrid.query(p[0], p[1]).some((c) => c.i !== self && pointInRing(p, c.ring));

  const occupied = new Map(); // "building:edge" -> [[t0, t1], ...] along the edge in meters
  const signs = [];
  let skipped = 0;
  for (const biz of businesses) {
    const p = biz.p;
    // Host building: the one containing the point, else the nearest within 12 m.
    let host = null, hd = Infinity;
    for (const c of bGrid.query(p[0], p[1])) {
      if (c.b.h < 3 || (c.b.mh || 0) > 2) continue;
      const d = pointInRing(p, c.ring) ? 0 : distToRing(p, [...c.ring, c.ring[0]]);
      if (d < hd) { hd = d; host = c; }
    }
    if (!host || hd > 12) { skipped++; continue; }
    let best = null;
    const ring = host.ring;
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k], b = ring[(k + 1) % ring.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 2.5) continue;
      const nx = (b[1] - a[1]) / len, ny = -(b[0] - a[0]) / len;
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const probe = [mid[0] + nx * 5, mid[1] + ny * 5];
      const road = !inOtherBuilding(probe, host.i) && nearRoad(probe, 9);
      const score = distToSeg(p, a, b) + (road ? 0 : 60);
      if (!best || score < best.score) best = { k, a, b, len, nx, ny, score, road };
    }
    if (!best || !best.road) { skipped++; continue; }
    const { a, b, len, nx, ny } = best;
    const w = Math.min(Math.max(1.8, biz.name.length * LETTER_M + 0.8), Math.min(len - 0.4, 9));
    const dx = (b[0] - a[0]) / len, dy = (b[1] - a[1]) / len;
    let t = Math.max(w / 2 + 0.2, Math.min(len - w / 2 - 0.2, (p[0] - a[0]) * dx + (p[1] - a[1]) * dy));
    // Slide along the facade to avoid overlapping a neighbour's sign.
    const key = `${host.i}:${best.k}`;
    const used = occupied.get(key) || [];
    const free = (c) => used.every(([u0, u1]) => c + w / 2 + 0.3 < u0 || c - w / 2 - 0.3 > u1);
    if (!free(t)) {
      let found = null;
      for (let s = 0.5; s < len && found === null; s += 0.5)
        for (const c of [t + s, t - s]) if (c - w / 2 >= 0.2 && c + w / 2 <= len - 0.2 && free(c)) { found = c; break; }
      if (found === null) { skipped++; continue; }
      t = found;
    }
    used.push([t - w / 2, t + w / 2]);
    occupied.set(key, used);
    const r1 = (v) => Math.round(v * 100) / 100;
    signs.push({
      t: biz.name, k: biz.kind, src: biz.src, type: biz.type,
      x: r1(a[0] + dx * t), y: r1(a[1] + dy * t), nx: r1(nx), ny: r1(ny), w: r1(w), b: host.i,
    });
  }
  return { signs, skipped };
}
