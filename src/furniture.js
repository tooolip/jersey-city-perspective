import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Y } from './builders.js';

// Street furniture at the positions Mapillary photo detections (or OSM) put it. Shapes and
// sizes follow US norms; finishes are generic unless noted.

// ------------------------------------------------------------------ simple instanced models

function part(geo, hex, [x, y, z] = [0, 0, 0]) {
  geo = geo.index ? geo.toNonIndexed() : geo;
  geo.translate(x, y, z);
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.deleteAttribute('uv');
  return geo;
}
const cyl = (r0, r1, h, seg = 8) => new THREE.CylinderGeometry(r0, r1, h, seg);
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);

// Models face north (-z) at rotation 0; instance rotation turns them to the compass heading `d`.
const MODELS = {
  // Cobra-head street light: pole plus an arm reaching over the street.
  lamp: () => [
    part(cyl(0.09, 0.14, 8.2), '#5b6063', [0, 4.1, 0]),
    part(box(0.08, 0.08, 2.2), '#5b6063', [0, 8.05, -1.05]),
    part(box(0.32, 0.14, 0.7), '#4a4e50', [0, 7.95, -2.15]),
    part(box(0.26, 0.03, 0.55), '#fff4d6', [0, 7.87, -2.15]),
  ],
  // Wooden utility pole with a crossarm across the street direction.
  pole: () => [
    part(cyl(0.13, 0.17, 11, 7), '#6b5a46', [0, 5.5, 0]),
    part(box(0.1, 0.1, 2.4), '#5d4f3e', [0, 10.2, 0]),
    part(box(0.1, 0.1, 1.6), '#5d4f3e', [0, 9.5, 0]),
  ],
  signal: () => [
    part(cyl(0.07, 0.09, 3.3), '#2a2c2e', [0, 1.65, 0]),
    part(box(0.36, 1.05, 0.28), '#2a2c2e', [0, 3.75, 0]),
    part(cyl(0.11, 0.11, 0.04, 10).rotateX(Math.PI / 2), '#c62a1f', [0, 4.08, -0.15]),
    part(cyl(0.11, 0.11, 0.04, 10).rotateX(Math.PI / 2), '#8a6d1d', [0, 3.75, -0.15]),
    part(cyl(0.11, 0.11, 0.04, 10).rotateX(Math.PI / 2), '#1f6b3a', [0, 3.42, -0.15]),
  ],
  pedsignal: () => [
    part(cyl(0.06, 0.08, 2.6), '#2a2c2e', [0, 1.3, 0]),
    part(box(0.42, 0.42, 0.22), '#2a2c2e', [0, 2.75, 0]),
    part(box(0.3, 0.3, 0.02), '#d9772b', [0, 2.75, -0.12]),
  ],
  hydrant: () => [
    part(cyl(0.12, 0.13, 0.6, 10), '#b02a22', [0, 0.32, 0]),
    part(cyl(0.16, 0.16, 0.06, 10), '#b02a22', [0, 0.05, 0]),
    part(cyl(0.09, 0.13, 0.14, 10), '#d9d4c8', [0, 0.68, 0]),
    part(cyl(0.05, 0.05, 0.36, 8).rotateZ(Math.PI / 2), '#d9d4c8', [0, 0.45, 0]),
  ],
  trash: () => [part(cyl(0.3, 0.27, 0.95, 10), '#2f3f34', [0, 0.475, 0]), part(cyl(0.32, 0.32, 0.06, 10), '#26332a', [0, 0.97, 0])],
  bench: () => [
    part(box(1.8, 0.06, 0.45), '#6b4a2f', [0, 0.45, 0]),
    part(box(1.8, 0.4, 0.05), '#6b4a2f', [0, 0.72, 0.21]),
    part(box(0.06, 0.45, 0.45), '#222222', [-0.8, 0.22, 0]),
    part(box(0.06, 0.45, 0.45), '#222222', [0.8, 0.22, 0]),
  ],
  cabinet: () => [part(box(0.8, 1.25, 0.5), '#7f8a82', [0, 0.625, 0])],
  bikerack: () => [
    part(box(0.05, 0.85, 0.05), '#555a5e', [-0.38, 0.425, 0]),
    part(box(0.05, 0.85, 0.05), '#555a5e', [0.38, 0.425, 0]),
    part(box(0.81, 0.05, 0.05), '#555a5e', [0, 0.85, 0]),
  ],
  mailbox: () => [part(box(0.5, 1.05, 0.55), '#1f4e8c', [0, 0.6, 0])],
  meter: () => [part(cyl(0.04, 0.04, 1.1), '#3a3d40', [0, 0.55, 0]), part(box(0.22, 0.35, 0.18), '#3a3d40', [0, 1.25, 0])],
  phone: () => [part(box(0.8, 2.2, 0.8), '#5d6266', [0, 1.1, 0])],
  bollard: () => [part(cyl(0.11, 0.11, 0.95, 10), '#2b2b2b', [0, 0.475, 0])],
  fountain: () => [part(cyl(0.18, 0.22, 0.95, 10), '#3c4a44', [0, 0.475, 0])],
  // Bus stop flag: pole with a sign panel.
  busstop: () => [part(cyl(0.04, 0.04, 2.8), '#9aa0a3', [0, 1.4, 0]), part(box(0.5, 0.65, 0.03), '#1d4f91', [0, 2.45, 0])],
  shelter: () => [
    part(box(3.6, 0.08, 1.6), '#4a4f53', [0, 2.45, 0]),
    part(box(3.6, 2.1, 0.03), '#a8bcc6', [0, 1.3, 0.75]),
    part(box(0.03, 2.1, 1.5), '#a8bcc6', [-1.78, 1.3, 0]),
    part(box(0.03, 2.1, 1.5), '#a8bcc6', [1.78, 1.3, 0]),
    part(box(1.8, 0.06, 0.4), '#4a4f53', [0, 0.5, 0.5]),
  ],
  // Citi Bike station (brand blue), drawn as a row of docks along the curb.
  bikeshare: () => {
    const parts = [part(box(0.5, 1.9, 0.35), '#0a59a8', [-3.4, 0.95, 0])];
    for (let i = 0; i < 9; i++) parts.push(part(box(0.12, 0.85, 0.3), '#0a59a8', [-2.6 + i * 0.75, 0.425, 0]));
    parts.push(part(box(7, 0.08, 0.5), '#3a3f44', [0, 0.04, 0]));
    return parts;
  },
  pathentrance: () => [part(box(0.35, 2.6, 0.35), '#2a2e33', [0, 1.3, 0]), part(box(0.55, 0.55, 0.37), '#e8e8e8', [0, 2.35, 0])],
  manhole: () => [part(cyl(0.38, 0.38, 0.02, 14), '#3b3a37', [0, Y.mark - 0.005, 0])],
  drain: () => [part(box(0.9, 0.02, 0.45), '#2c2c2b', [0, Y.mark - 0.005, -0.1])],
};

// Rough heights for the inspector's hit test.
export const FURNITURE_HEIGHT = { lamp: 8.2, pole: 11, signal: 4.3, pedsignal: 3, hydrant: 0.8, trash: 1, bench: 0.95, cabinet: 1.25, bikerack: 0.9, mailbox: 1.1, meter: 1.4, phone: 2.2, bollard: 1, fountain: 1, busstop: 2.8, shelter: 2.5, bikeshare: 1.9, pathentrance: 2.6, sign: 3.1 };

// ------------------------------------------------------------------ sign faces (MUTCD-style)

const CELL = 256, ATLAS = 2048, COLS = ATLAS / CELL;
const FLUOR = '#c8e03a'; // fluorescent yellow-green (pedestrian / school)
const YELLOW = '#f3c11b';

// Map a Mapillary sign class to a face: { key, w, h (meters), draw(g, s) }.
function faceFor(v) {
  const [cat, name] = v.split('--');
  const speed = /maximum-speed-limit-(\d+)/.exec(v);
  if (v.startsWith('regulatory--stop--')) return { key: 'stop', w: 0.76, h: 0.76, draw: drawStop };
  if (v.startsWith('regulatory--yield')) return { key: 'yield', w: 0.9, h: 0.8, draw: drawYield };
  if (/one-way-(left|right)/.test(v)) {
    const dir = v.includes('left') ? -1 : 1;
    return { key: `oneway${dir}`, w: 0.9, h: 0.3, draw: (g, s) => drawOneWay(g, s, dir) };
  }
  if (v.startsWith('regulatory--no-entry')) return { key: 'noentry', w: 0.76, h: 0.76, draw: drawNoEntry };
  if (speed && +speed[1] <= 65 && cat === 'regulatory') return { key: `speed${speed[1]}`, w: 0.6, h: 0.76, draw: (g, s) => drawSpeed(g, s, speed[1]) };
  if (speed && +speed[1] <= 65) return { key: `advisory${speed[1]}`, w: 0.45, h: 0.45, draw: (g, s) => drawPlate(g, s, YELLOW, '#111', [`${speed[1]}`, 'MPH']) };
  if (/no-parking|no-stopping/.test(v)) return { key: 'nopark', w: 0.3, h: 0.45, draw: drawNoParking };
  if (v.startsWith('regulatory--parking-restrictions')) return { key: 'parkrestrict', w: 0.3, h: 0.45, draw: (g, s) => drawPlate(g, s, '#fff', '#b3261e', ['NO', 'PARKING', '8AM–6PM', 'MON–FRI'], '#1d7a3a') };
  if (/no-(left|right|u)-turn|no-turns/.test(v)) return { key: name, w: 0.6, h: 0.6, draw: (g, s) => drawProhibitedTurn(g, s, name) };
  if (v.includes('no-turn-on-red')) return { key: 'notor', w: 0.6, h: 0.76, draw: (g, s) => drawPlate(g, s, '#fff', '#111', ['NO', 'TURN', 'ON', 'RED']) };
  if (v.includes('no-heavy-goods') || v.includes('trucks')) return { key: 'notrucks', w: 0.6, h: 0.6, draw: (g, s) => drawPlate(g, s, '#fff', '#111', ['NO', 'TRUCKS']) };
  if (v.includes('do-not-block')) return { key: 'dnb', w: 0.6, h: 0.76, draw: (g, s) => drawPlate(g, s, '#fff', '#111', ['DO NOT', 'BLOCK', 'INTER-', 'SECTION']) };
  if (v.includes('pedestrians-crossing') || v.includes('children') || v.includes('playground')) return { key: 'pedx', w: 0.76, h: 0.76, draw: (g, s) => drawDiamond(g, s, FLUOR, drawWalker) };
  if (v.includes('school-zone')) return { key: 'school', w: 0.76, h: 0.76, draw: drawSchool };
  if (v.includes('traffic-signals')) return { key: 'signalahead', w: 0.76, h: 0.76, draw: (g, s) => drawDiamond(g, s, YELLOW, drawSignalIcon) };
  if (v.includes('railroad')) return { key: 'rr', w: 0.76, h: 0.76, draw: (g, s) => drawDiamond(g, s, YELLOW, (gg, ss) => drawLetters(gg, ss, ['RR'])) };
  if (cat === 'warning') return { key: 'warn', w: 0.76, h: 0.76, draw: (g, s) => drawDiamond(g, s, YELLOW, (gg, ss) => drawLetters(gg, ss, ['!'])) };
  if (v.includes('disabled-persons')) return { key: 'ada', w: 0.3, h: 0.45, draw: (g, s) => drawPlate(g, s, '#1d4f91', '#fff', ['♿', 'RESERVED']) };
  if (v.includes('information--parking')) return { key: 'parking', w: 0.45, h: 0.45, draw: (g, s) => drawPlate(g, s, '#1d4f91', '#fff', ['P']) };
  if (v.includes('bike-route')) return { key: 'bikeroute', w: 0.45, h: 0.6, draw: (g, s) => drawPlate(g, s, '#1d6b3a', '#fff', ['BIKE', 'ROUTE']) };
  if (v.includes('interstate')) return { key: 'interstate', w: 0.6, h: 0.6, draw: (g, s) => drawPlate(g, s, '#1d4f91', '#fff', ['I-78']) };
  if (v.includes('highway-interchange') || v.includes('highway-exit')) return { key: 'guide', w: 1.5, h: 0.75, draw: (g, s) => drawPlate(g, s, '#1d6b3a', '#fff', ['HOLLAND', 'TUNNEL']) };
  if (/chevron|one-direction/.test(v)) {
    const dir = v.includes('left') ? -1 : 1;
    return { key: `chev${dir}`, w: 0.45, h: 0.6, draw: (g, s) => drawChevron(g, s, dir) };
  }
  if (v.includes('keep-left') || v.includes('keep-right')) return { key: v.includes('left') ? 'keepl' : 'keepr', w: 0.6, h: 0.76, draw: (g, s) => drawPlate(g, s, '#fff', '#111', ['KEEP', v.includes('left') ? 'LEFT' : 'RIGHT']) };
  if (cat === 'complementary') return { key: 'plate', w: 0.45, h: 0.3, draw: (g, s) => drawPlate(g, s, '#fff', '#555', ['▬▬▬', '▬▬']) };
  if (cat === 'information') return { key: 'info', w: 0.6, h: 0.45, draw: (g, s) => drawPlate(g, s, '#1d6b3a', '#fff', ['▬▬▬', '▬▬']) };
  // Other regulatory signs, and fronts Mapillary couldn't classify.
  return { key: 'reg', w: 0.6, h: 0.76, draw: (g, s) => drawPlate(g, s, '#fff', '#444', ['▬▬▬', '▬▬', '▬▬▬']) };
}

const fontStack = (px, w = 800) => `${w} ${px}px "Helvetica Neue", Arial, sans-serif`;

// Every drawer paints into a box of size s.w x s.h (pixels) at the cell origin.
function rectPath(g, s, r = 10) {
  g.beginPath();
  g.roundRect(2, 2, s.w - 4, s.h - 4, r);
}
function drawPlate(g, s, bg, fg, lines, accent) {
  rectPath(g, s);
  g.fillStyle = bg;
  g.fill();
  g.lineWidth = 6;
  g.strokeStyle = fg === '#fff' ? '#fff' : '#111';
  g.stroke();
  drawLetters(g, s, lines, fg, accent);
}
function drawLetters(g, s, lines, fg = '#111', accent) {
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const lh = (s.h * 0.78) / lines.length;
  lines.forEach((t, i) => {
    let size = Math.min(lh * 0.85, s.h * 0.6);
    g.font = fontStack(size);
    const mw = g.measureText(t).width;
    if (mw > s.w * 0.84) { size *= (s.w * 0.84) / mw; g.font = fontStack(size); }
    g.fillStyle = accent && i >= 2 ? accent : fg;
    g.fillText(t, s.w / 2, s.h * 0.11 + lh * (i + 0.5));
  });
}
function polygon(g, pts) {
  g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
}
function drawStop(g, s) {
  const c = s.w / 2, r = s.w / 2 - 2;
  const pts = [...Array(8)].map((_, i) => [c + r * Math.cos(Math.PI / 8 + (i * Math.PI) / 4), c + r * Math.sin(Math.PI / 8 + (i * Math.PI) / 4)]);
  polygon(g, pts);
  g.fillStyle = '#fff';
  g.fill();
  polygon(g, pts.map(([x, y]) => [c + (x - c) * 0.9, c + (y - c) * 0.9]));
  g.fillStyle = '#c1121f';
  g.fill();
  g.fillStyle = '#fff';
  g.font = fontStack(s.w * 0.3);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('STOP', c, c + 4);
}
function drawYield(g, s) {
  polygon(g, [[2, 2], [s.w - 2, 2], [s.w / 2, s.h - 2]]);
  g.fillStyle = '#c1121f';
  g.fill();
  polygon(g, [[s.w * 0.22, s.h * 0.12], [s.w * 0.78, s.h * 0.12], [s.w / 2, s.h * 0.72]]);
  g.fillStyle = '#fff';
  g.fill();
  g.fillStyle = '#c1121f';
  g.font = fontStack(s.w * 0.11);
  g.textAlign = 'center';
  g.fillText('YIELD', s.w / 2, s.h * 0.3);
}
function drawOneWay(g, s, dir) {
  rectPath(g, s, 6);
  g.fillStyle = '#111';
  g.fill();
  g.save();
  g.translate(s.w / 2, s.h / 2);
  g.scale(dir, 1);
  const L = s.w * 0.42, T = s.h * 0.16;
  polygon(g, [[-L, -T], [L * 0.55, -T], [L * 0.55, -T * 2.4], [L, 0], [L * 0.55, T * 2.4], [L * 0.55, T], [-L, T]]);
  g.fillStyle = '#fff';
  g.fill();
  g.restore();
  g.fillStyle = '#111';
  g.font = fontStack(s.h * 0.26);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('ONE WAY', s.w / 2 - dir * s.w * 0.06, s.h / 2 + 1);
}
function drawNoEntry(g, s) {
  const c = s.w / 2;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, s.w, s.h);
  g.beginPath();
  g.arc(c, c, c * 0.92, 0, Math.PI * 2);
  g.fillStyle = '#c1121f';
  g.fill();
  g.fillStyle = '#fff';
  g.fillRect(c * 0.3, c * 0.88, c * 1.4, c * 0.24);
  g.font = fontStack(c * 0.22);
  g.textAlign = 'center';
  g.fillText('DO NOT', c, c * 0.62);
  g.fillText('ENTER', c, c * 1.5);
}
function drawSpeed(g, s, n) {
  rectPath(g, s);
  g.fillStyle = '#fff';
  g.fill();
  g.lineWidth = 5;
  g.strokeStyle = '#111';
  g.stroke();
  g.fillStyle = '#111';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = fontStack(s.h * 0.13);
  g.fillText('SPEED', s.w / 2, s.h * 0.18);
  g.fillText('LIMIT', s.w / 2, s.h * 0.33);
  g.font = fontStack(s.h * 0.45);
  g.fillText(n, s.w / 2, s.h * 0.68);
}
function drawNoParking(g, s) {
  rectPath(g, s, 6);
  g.fillStyle = '#fff';
  g.fill();
  g.lineWidth = 4;
  g.strokeStyle = '#c1121f';
  g.stroke();
  const c = [s.w / 2, s.h * 0.42], r = s.w * 0.34;
  g.fillStyle = '#111';
  g.font = fontStack(r * 1.3);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('P', c[0], c[1] + 2);
  g.lineWidth = 8;
  g.strokeStyle = '#c1121f';
  g.beginPath();
  g.arc(c[0], c[1], r, 0, Math.PI * 2);
  g.moveTo(c[0] - r * 0.7, c[1] - r * 0.7);
  g.lineTo(c[0] + r * 0.7, c[1] + r * 0.7);
  g.stroke();
  g.fillStyle = '#c1121f';
  g.font = fontStack(s.h * 0.1);
  g.fillText('TOW ZONE', s.w / 2, s.h * 0.86);
}
function drawProhibitedTurn(g, s, name) {
  rectPath(g, s);
  g.fillStyle = '#fff';
  g.fill();
  g.lineWidth = 4;
  g.strokeStyle = '#111';
  g.stroke();
  const c = s.w / 2;
  g.strokeStyle = '#111';
  g.lineWidth = s.w * 0.08;
  g.beginPath();
  g.moveTo(c, s.h * 0.8);
  if (name.includes('u-turn')) {
    g.lineTo(c - s.w * 0.1, s.h * 0.4);
    g.arc(c, s.h * 0.4, s.w * 0.1, Math.PI, 0);
    g.lineTo(c + s.w * 0.1, s.h * 0.6);
  } else if (name.includes('left') || name.includes('right')) {
    const dir = name.includes('left') ? -1 : 1;
    g.lineTo(c, s.h * 0.4);
    g.lineTo(c + dir * s.w * 0.22, s.h * 0.4);
  } else g.lineTo(c, s.h * 0.25);
  g.stroke();
  g.strokeStyle = '#c1121f';
  g.lineWidth = s.w * 0.07;
  g.beginPath();
  g.arc(c, s.h / 2, s.w * 0.38, 0, Math.PI * 2);
  g.moveTo(c - s.w * 0.27, s.h / 2 - s.w * 0.27);
  g.lineTo(c + s.w * 0.27, s.h / 2 + s.w * 0.27);
  g.stroke();
}
function drawDiamond(g, s, bg, icon) {
  const c = s.w / 2;
  polygon(g, [[c, 2], [s.w - 2, c], [c, s.h - 2], [2, c]]);
  g.fillStyle = bg;
  g.fill();
  g.lineWidth = 6;
  g.strokeStyle = '#111';
  g.stroke();
  icon(g, { w: s.w, h: s.h });
}
function drawWalker(g, s) {
  const c = s.w / 2;
  g.fillStyle = '#111';
  g.beginPath();
  g.arc(c, s.h * 0.3, s.w * 0.05, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = s.w * 0.055;
  g.strokeStyle = '#111';
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(c, s.h * 0.37); g.lineTo(c - s.w * 0.02, s.h * 0.56);
  g.lineTo(c - s.w * 0.1, s.h * 0.7); g.moveTo(c - s.w * 0.02, s.h * 0.56); g.lineTo(c + s.w * 0.08, s.h * 0.7);
  g.moveTo(c - s.w * 0.1, s.h * 0.45); g.lineTo(c + s.w * 0.09, s.h * 0.47);
  g.stroke();
}
function drawSignalIcon(g, s) {
  const c = s.w / 2;
  g.fillStyle = '#111';
  g.fillRect(c - s.w * 0.07, s.h * 0.3, s.w * 0.14, s.h * 0.4);
  [['#c1121f', 0.37], ['#f3c11b', 0.5], ['#1d7a3a', 0.63]].forEach(([col, y]) => {
    g.fillStyle = col;
    g.beginPath();
    g.arc(c, s.h * y, s.w * 0.04, 0, Math.PI * 2);
    g.fill();
  });
}
function drawSchool(g, s) {
  polygon(g, [[s.w / 2, 2], [s.w - 2, s.h * 0.4], [s.w - 2, s.h - 2], [2, s.h - 2], [2, s.h * 0.4]]);
  g.fillStyle = FLUOR;
  g.fill();
  g.lineWidth = 6;
  g.strokeStyle = '#111';
  g.stroke();
  drawLetters(g, { w: s.w, h: s.h * 1.3 }, ['SCHOOL'], '#111');
}
function drawChevron(g, s, dir) {
  rectPath(g, s, 4);
  g.fillStyle = YELLOW;
  g.fill();
  g.save();
  g.translate(s.w / 2, s.h / 2);
  g.scale(dir, 1);
  polygon(g, [[-s.w * 0.3, -s.h * 0.4], [s.w * 0.05, -s.h * 0.4], [s.w * 0.35, 0], [s.w * 0.05, s.h * 0.4], [-s.w * 0.3, s.h * 0.4], [0, 0]]);
  g.fillStyle = '#111';
  g.fill();
  g.restore();
}
function drawBlade(g, s, name) {
  rectPath(g, s, 6);
  g.fillStyle = '#1d6b3a';
  g.fill();
  g.lineWidth = 4;
  g.strokeStyle = '#fff';
  g.stroke();
  drawLetters(g, s, [name.toUpperCase()], '#fff');
}

// Road decals (white paint on transparent).
function drawArrow(g, s, v) {
  g.fillStyle = '#e8e6df';
  const c = s.w / 2;
  const shaft = () => g.fillRect(c - s.w * 0.06, s.h * 0.35, s.w * 0.12, s.h * 0.63);
  const head = (x, y, ang) => {
    g.save();
    g.translate(x, y);
    g.rotate(ang);
    polygon(g, [[0, -s.h * 0.2], [s.w * 0.22, s.h * 0.05], [-s.w * 0.22, s.h * 0.05]]);
    g.fill();
    g.restore();
  };
  shaft();
  if (v.includes('straight')) head(c, s.h * 0.2, 0);
  if (v.includes('left')) { g.fillRect(c - s.w * 0.32, s.h * 0.42, s.w * 0.32, s.w * 0.12); head(c - s.w * 0.32, s.h * 0.48, -Math.PI / 2); }
  if (v.includes('right')) { g.fillRect(c, s.h * 0.42, s.w * 0.32, s.w * 0.12); head(c + s.w * 0.32, s.h * 0.48, Math.PI / 2); }
}
function drawSharrow(g, s) {
  g.strokeStyle = '#e8e6df';
  g.lineWidth = s.w * 0.06;
  for (const y of [0.12, 0.27]) {
    g.beginPath();
    g.moveTo(s.w * 0.2, s.h * (y + 0.1));
    g.lineTo(s.w * 0.5, s.h * y);
    g.lineTo(s.w * 0.8, s.h * (y + 0.1));
    g.stroke();
  }
  for (const y of [0.55, 0.82]) {
    g.beginPath();
    g.arc(s.w / 2, s.h * y, s.w * 0.17, 0, Math.PI * 2);
    g.stroke();
  }
}

class Atlas {
  constructor(renderer) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = ATLAS;
    this.g = this.canvas.getContext('2d');
    this.cells = new Map();
    this.renderer = renderer;
  }
  // Returns UV rect for a face drawn at the face's aspect ratio inside one cell.
  get(key, w, h, draw) {
    if (this.cells.has(key)) return this.cells.get(key);
    const i = this.cells.size;
    if (i >= COLS * COLS) return this.cells.values().next().value;
    const scale = (CELL - 4) / Math.max(w, h);
    const pw = Math.round(w * scale), ph = Math.round(h * scale);
    const x = (i % COLS) * CELL + 2, y = Math.floor(i / COLS) * CELL + 2;
    this.g.save();
    this.g.translate(x, y);
    draw(this.g, { w: pw, h: ph });
    this.g.restore();
    const uv = { u0: x / ATLAS, u1: (x + pw) / ATLAS, v0: 1 - (y + ph) / ATLAS, v1: 1 - y / ATLAS };
    this.cells.set(key, uv);
    return uv;
  }
  texture() {
    const t = new THREE.CanvasTexture(this.canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    return t;
  }
}

// Quad builder: vertical (facing compass heading d) or flat on the road.
function pushQuad(arr, { x, y, z, d, w, h, uv, flat = false, offset = 0 }) {
  const a = (d * Math.PI) / 180;
  const fx = Math.sin(a), fy = Math.cos(a); // facing direction in [east, north]
  // Reader's right: facing the sign (looking along -f) it's (-fy, fx); driving over a decal
  // towards f it's (fy, -fx).
  const rx = flat ? fy : -fy, ry = flat ? -fx : fx;
  const cx = x + fx * offset, cy = y + fy * offset;
  let corners;
  if (flat) {
    // Flat decal, reading "up" along heading d.
    corners = [
      [cx - rx * w / 2 - fx * h / 2, cy - ry * w / 2 - fy * h / 2, z, uv.u0, uv.v0],
      [cx + rx * w / 2 - fx * h / 2, cy + ry * w / 2 - fy * h / 2, z, uv.u1, uv.v0],
      [cx + rx * w / 2 + fx * h / 2, cy + ry * w / 2 + fy * h / 2, z, uv.u1, uv.v1],
      [cx - rx * w / 2 + fx * h / 2, cy - ry * w / 2 + fy * h / 2, z, uv.u0, uv.v1],
    ];
  } else {
    corners = [
      [cx - rx * w / 2, cy - ry * w / 2, z - h / 2, uv.u0, uv.v0],
      [cx + rx * w / 2, cy + ry * w / 2, z - h / 2, uv.u1, uv.v0],
      [cx + rx * w / 2, cy + ry * w / 2, z + h / 2, uv.u1, uv.v1],
      [cx - rx * w / 2, cy - ry * w / 2, z + h / 2, uv.u0, uv.v1],
    ];
  }
  const n = flat ? [0, 1, 0] : [fx, 0, -fy];
  for (const k of [0, 1, 2, 0, 2, 3]) {
    const [e, nn, up, u, v] = corners[k];
    arr.pos.push(e, up, -nn);
    arr.uv.push(u, v);
    arr.nrm.push(...n);
  }
}

export function buildFurniture(items, renderer, streetAt) {
  const group = new THREE.Group();
  const byKind = new Map();
  for (const it of items) {
    if (!byKind.has(it.k)) byKind.set(it.k, []);
    byKind.get(it.k).push(it);
  }

  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.1 });
  for (const [kind, list] of byKind) {
    const model = MODELS[kind];
    if (!model) continue;
    const geo = mergeGeometries(model());
    const inst = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((it, i) => {
      q.setFromAxisAngle(up, (-(it.d || 0) * Math.PI) / 180);
      m.compose(p.set(it.x, 0, -it.y), q, s);
      inst.setMatrixAt(i, m);
    });
    inst.castShadow = !['manhole', 'drain'].includes(kind);
    inst.receiveShadow = true;
    inst.computeBoundingSphere();
    inst.name = `furniture-${kind}`;
    group.add(inst);
  }

  // Traffic signs: shared posts, stacked panels, MUTCD-style faces from one atlas.
  const atlas = new Atlas(renderer);
  const faces = { pos: [], uv: [], nrm: [] };
  const backs = { pos: [], uv: [], nrm: [] };
  const decals = { pos: [], uv: [], nrm: [] };
  const signs = byKind.get('sign') || [];
  const posts = new Map();
  for (const sg of signs) {
    if (!posts.has(sg.post)) posts.set(sg.post, []);
    posts.get(sg.post).push(sg);
  }
  const postList = [];
  for (const list of posts.values()) {
    list.sort((a, b) => a.slot - b.slot);
    let top = 3.05;
    for (const sg of list) {
      let face;
      if (sg.v.startsWith('information--general-directions')) {
        // Street-name blade: the street it stands on (from OSM), readable from the cross street.
        const name = streetAt(sg.x, sg.y) || 'STREET';
        face = { key: `blade:${name}`, w: Math.min(1.4, 0.35 + name.length * 0.075), h: 0.2, draw: (g, ss) => drawBlade(g, ss, name) };
        sg.label = name;
      } else face = faceFor(sg.v);
      const uv = atlas.get(face.key, face.w, face.h, face.draw);
      const zc = top - face.h / 2;
      pushQuad(faces, { x: sg.x, y: sg.y, z: zc, d: sg.d ?? 0, w: face.w, h: face.h, uv, offset: 0.05 });
      pushQuad(backs, { x: sg.x, y: sg.y, z: zc, d: (sg.d ?? 0) + 180, w: face.w, h: face.h, uv: { u0: 0, u1: 0, v0: 0, v1: 0 }, offset: -0.04 });
      top -= face.h + 0.06;
    }
    postList.push([list[0].x, list[0].y]);
  }
  for (const it of byKind.get('arrow') || []) {
    const uv = atlas.get(`arrow:${it.v}`, 1.2, 4.5, (g, ss) => drawArrow(g, ss, it.v));
    pushQuad(decals, { x: it.x, y: it.y, z: Y.mark + 0.005, d: it.d ?? 0, w: 1.2, h: 4.5, uv, flat: true });
  }
  for (const it of byKind.get('bikesymbol') || []) {
    const uv = atlas.get('sharrow', 1, 2.8, drawSharrow);
    pushQuad(decals, { x: it.x, y: it.y, z: Y.mark + 0.005, d: it.d ?? 0, w: 1, h: 2.8, uv, flat: true });
  }
  // Stop lines: 0.45 m bar from the centreline to the curb on the approach side.
  const white = atlas.get('white', 1, 1, (g, ss) => { g.fillStyle = '#e8e6df'; g.fillRect(0, 0, ss.w, ss.h); });
  for (const it of byKind.get('stopline') || []) {
    const a = (it.d * Math.PI) / 180;
    const ox = Math.cos(a) * -it.side, oy = -Math.sin(a) * -it.side; // left/right of travel
    pushQuad(decals, { x: it.x + ox * it.w / 2, y: it.y + oy * it.w / 2, z: Y.mark + 0.004, d: it.d, w: it.w, h: 0.45, uv: white, flat: true });
  }

  const tex = atlas.texture();
  const mk = (buf, material) => {
    if (!buf.pos.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uv, 2));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(buf.nrm, 3));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, material);
    mesh.receiveShadow = true;
    return mesh;
  };
  const faceMesh = mk(faces, new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5, roughness: 0.5, emissive: '#ffffff', emissiveMap: tex, emissiveIntensity: 0.12 }));
  const backMesh = mk(backs, new THREE.MeshStandardMaterial({ color: '#8d9296', roughness: 0.6, metalness: 0.4 }));
  const decalMesh = mk(decals, new THREE.MeshStandardMaterial({ map: tex, transparent: true, depthWrite: false, roughness: 0.9 }));
  for (const mesh of [faceMesh, backMesh, decalMesh]) if (mesh) group.add(mesh);
  if (faceMesh) faceMesh.castShadow = true;

  if (postList.length) {
    const geo = new THREE.CylinderGeometry(0.03, 0.03, 3.1, 6);
    geo.translate(0, 1.55, 0);
    const inst = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: '#9aa0a3', roughness: 0.5, metalness: 0.6 }), postList.length);
    postList.forEach(([x, y], i) => inst.setMatrixAt(i, m.makeTranslation(x, 0, -y)));
    inst.castShadow = true;
    inst.computeBoundingSphere();
    group.add(inst);
  }
  return group;
}
