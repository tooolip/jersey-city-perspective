import * as THREE from 'three';
import { signStyle } from './signs.js';
import { FURNITURE_HEIGHT } from './furniture.js';

const PROP_CLASS = {
  1: 'Vacant land', 2: 'Residential (1–4 units)', '4A': 'Commercial', '4B': 'Industrial', '4C': 'Apartments (5+ units)',
  '5A': 'Railroad', '5B': 'Railroad', '15A': 'Public school', '15B': 'Other school', '15C': 'Public property',
  '15D': 'Church / charitable', '15E': 'Cemetery', '15F': 'Other exempt',
};

const FURNITURE_LABEL = {
  lamp: 'Street light', pole: 'Utility pole', signal: 'Traffic signal', pedsignal: 'Pedestrian signal',
  hydrant: 'Fire hydrant', trash: 'Trash can', bench: 'Bench', cabinet: 'Utility cabinet', bikerack: 'Bike rack',
  mailbox: 'Mailbox', meter: 'Parking meter', phone: 'Phone booth', bollard: 'Bollard', fountain: 'Drinking fountain',
  busstop: 'Bus stop', shelter: 'Bus shelter', bikeshare: 'Citi Bike station', pathentrance: 'PATH entrance', sign: 'Traffic sign',
};
// Hit radius around an object's position for the aim test.
const FURNITURE_RADIUS = { shelter: 1.8, bikeshare: 3.6, bench: 0.9, cabinet: 0.5, sign: 0.45 };
const CELL = 3;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const row = (label, value, source, warn) =>
  `<tr><th>${label}</th><td>${value}${warn ? ` <span class="warn">${warn}</span>` : ''}</td><td class="src">${source || ''}</td></tr>`;

// Aim at a building and see what the records say about it, with the source of each value.
export class Inspector {
  constructor(panel, crosshair, query, data) {
    this.panel = panel;
    this.crosshair = crosshair;
    this.query = query;
    this.active = false;
    this.signsByBuilding = new Map();
    for (const s of data.signs || []) {
      const b = data.buildings[s.b];
      if (!this.signsByBuilding.has(b)) this.signsByBuilding.set(b, []);
      this.signsByBuilding.get(b).push(s);
    }
    this.furniture = new Map();
    for (const f of data.furniture || []) {
      if (!FURNITURE_HEIGHT[f.k]) continue;
      const k = `${Math.floor(f.x / CELL)},${Math.floor(f.y / CELL)}`;
      if (!this.furniture.has(k)) this.furniture.set(k, []);
      this.furniture.get(k).push(f);
    }
    this.last = undefined;
    this.dir = new THREE.Vector3();
  }

  toggle() {
    this.active = !this.active;
    this.panel.classList.toggle('hidden', !this.active);
    this.crosshair.classList.toggle('hidden', !this.active);
    this.last = undefined;
  }

  pick(camera) {
    camera.getWorldDirection(this.dir);
    const o = camera.position;
    for (let t = 0.5; t < 250; t += 0.4) {
      const x = o.x + this.dir.x * t, y = o.y + this.dir.y * t, z = o.z + this.dir.z * t;
      if (y < 0) return null;
      const n = -z;
      for (const f of this.furniture.get(`${Math.floor(x / CELL)},${Math.floor(n / CELL)}`) || []) {
        if (y <= FURNITURE_HEIGHT[f.k] && Math.hypot(f.x - x, f.y - n) < (FURNITURE_RADIUS[f.k] || 0.35)) return { f, dist: t };
      }
      const b = this.query.buildingAt(x, -z);
      if (b && y <= b.h && y >= (b.mh || 0)) return { b, dist: t };
    }
    return null;
  }

  update(camera) {
    if (!this.active) return;
    const hit = this.pick(camera);
    const target = hit?.b || hit?.f || null;
    if (target === this.last) return;
    this.last = target;
    this.panel.innerHTML = hit?.b ? this.describe(hit.b) : hit?.f ? this.describeFurniture(hit.f) : '<p class="hint">Aim at a building or street object</p>';
  }

  describeFurniture(f) {
    const rows = [];
    if (f.k === 'sign') {
      const [cat, ...rest] = f.v.split('--');
      const type = f.v === 'object--traffic-sign--front' ? 'unclassified sign' : `${cat}: ${rest[0].replace(/-/g, ' ')}`;
      rows.push(row('Type', esc(type), 'Mapillary classification'));
      if (f.label) rows.push(row('Text', esc(f.label), 'Street name from OSM'));
      rows.push(row('Face', f.v.startsWith('information--general-directions') ? 'Street-name blade' : 'Standard US (MUTCD) design for this type', 'Drawn, not photographed'));
    }
    if (f.n) rows.push(row('Name', esc(f.n), 'OSM'));
    if (f.cap) rows.push(row('Docks', f.cap, 'OSM'));
    if (f.s === 'mly') {
      rows.push(row('Seen', f.yr ? `last photographed ${f.yr}` : 'yes', 'Mapillary street-level photos'));
      rows.push(row('Position', '±~3 m', 'Triangulated from photos, snapped to sidewalk'));
    } else rows.push(row('Source', 'Mapped', 'OpenStreetMap'));
    if (f.d !== undefined && f.k !== 'pole' && f.k !== 'lamp') rows.push(row('Facing', `${Math.round(((f.d % 360) + 360) % 360)}°`, f.s === 'mly' ? 'Mapillary' : 'Street direction'));
    rows.push(row('Model', 'Generic shape and colour', ''));
    return `<h2>${FURNITURE_LABEL[f.k] || f.k}</h2><table>${rows.join('')}</table>`;
  }

  describe(b) {
    const tax = b.tax || {};
    const title = tax.addr || b.n || 'Unaddressed building';
    const rows = [];
    if (b.n && tax.addr) rows.push(row('Name', esc(b.n), 'Overture / OSM'));
    if (tax.facility) rows.push(row('Facility', esc(tax.facility), 'Tax record'));

    const hSrc = b.est === 'storeys' ? 'Estimated from storeys' : b.est ? 'Estimate (no data)' : 'LiDAR (USGS via Overture)';
    rows.push(row('Height', `${b.h.toFixed(1)} m`, hSrc));
    if (tax.storeys) {
      const perFloor = (b.h - (b.mh || 0)) / Math.ceil(tax.storeys);
      const disagree = !b.est && (perFloor < 2.4 || perFloor > 6) ? 'height and storeys disagree' : '';
      rows.push(row('Storeys', tax.storeys, 'Tax record', disagree));
    }
    if (tax.year) rows.push(row('Built', tax.year, 'Tax record'));
    if (tax.material) rows.push(row('Construction', esc(tax.material), `Inferred from “${esc(tax.desc)}”`));
    else if (tax.desc) rows.push(row('Description', esc(tax.desc), 'Tax record'));
    if (tax.units) rows.push(row('Units', `${tax.units}${tax.condo ? ' (condo)' : ''}`, 'Tax record'));
    if (tax.cls) rows.push(row('Use', esc(PROP_CLASS[tax.cls] || tax.cls), 'Tax record'));
    if (tax.lotSize) rows.push(row('Lot', `${esc(tax.lotSize)} ft`, `Block/Lot ${esc(tax.bl)}`));
    if (b.rc) rows.push(row('Roof colour', `<span class="swatch" style="background:${b.rc}"></span>${b.rc}`, 'NAIP 2023 aerial photo'));
    rows.push(row('Facade colour', b.fc ? esc(b.fc) : 'not in data yet', b.fc ? 'Mapped' : 'Palette from material/era'));

    const signs = this.signsByBuilding.get(b) || [];
    const biz = signs.map((s) => {
      const st = signStyle(s);
      return `<li><span class="swatch" style="background:${st.bg}"></span>${esc(s.t)} <span class="src">${s.src === 'osm' ? 'OSM' : 'Overture'} · ${st.brand ? 'brand colours' : 'generic colours'}</span></li>`;
    });
    return `<h2>${esc(title)}</h2><table>${rows.join('')}</table>${biz.length ? `<h3>Businesses</h3><ul>${biz.join('')}</ul>` : ''}`;
  }
}
