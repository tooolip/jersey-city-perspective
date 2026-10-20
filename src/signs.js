import * as THREE from 'three';

// Storefront fascia signs with the business's real name, plus ground-floor glazing beneath.
// Chains use their known brand colours; others get a generic colour by kind (flagged as such).

const SIGN_H = 0.75; // m
const SIGN_BOTTOM = 2.9; // m above the sidewalk
const GLAZING_TOP = 2.75;

const KIND_STYLE = {
  food: ['#7a1f1f', '#f6e7c8'],
  cafe: ['#2f4a3a', '#f1e6d2'],
  bar: ['#151515', '#e9c46a'],
  bank: ['#123a6b', '#ffffff'],
  beauty: ['#f2d7de', '#5a2340'],
  health: ['#ffffff', '#0b6e4f'],
  fitness: ['#111111', '#ff6a13'],
  hotel: ['#2b2118', '#d9b26f'],
  shop: ['#1f2a44', '#ffffff'],
};

// Known chains present in the area: [match, background, text].
const BRANDS = [
  [/^starbucks/, '#00704a', '#ffffff'], [/^cvs/, '#cc0000', '#ffffff'], [/^staples/, '#cc0000', '#ffffff'],
  [/^dunkin/, '#ff6e1b', '#ffffff'], [/^7.?eleven/, '#ffffff', '#008163'], [/^chase/, '#117aca', '#ffffff'],
  [/^bank of america/, '#012169', '#ffffff'], [/^td bank/, '#2a7d2e', '#ffffff'], [/^wells fargo/, '#d71e28', '#ffcd41'],
  [/^citi/, '#003b70', '#ffffff'], [/^santander/, '#ec0000', '#ffffff'], [/^pnc/, '#f58025', '#ffffff'],
  [/^mcdonald/, '#da291c', '#ffc72c'], [/^subway/, '#008c15', '#ffc600'], [/^walgreens|^duane reade/, '#e31837', '#ffffff'],
  [/^target/, '#cc0000', '#ffffff'], [/^shoprite/, '#e21a2c', '#ffffff'], [/^whole foods/, '#00674b', '#ffffff'],
  [/^trader joe/, '#c8102e', '#ffffff'], [/^chipotle/, '#451400', '#ffffff'], [/^sweetgreen/, '#0f3a2b', '#ffffff'],
  [/^blink/, '#1e1e1e', '#ffd100'], [/^planet fitness/, '#5c2d91', '#ffde00'], [/^equinox/, '#000000', '#ffffff'],
  [/^ups/, '#351c15', '#ffb500'], [/^fedex/, '#4d148c', '#ff6600'], [/^verizon/, '#000000', '#ffffff'],
  [/^t-?mobile/, '#e20074', '#ffffff'], [/^at&t/, '#00a8e0', '#ffffff'], [/^gap/, '#002868', '#ffffff'],
  [/^panera/, '#6a7d3a', '#ffffff'], [/^shake shack/, '#1f1f1f', '#7ab648'], [/^popeyes/, '#f26722', '#ffffff'],
  [/^domino/, '#006491', '#ffffff'], [/^papa john/, '#006341', '#ffffff'], [/^kfc/, '#a3080c', '#ffffff'],
  [/^wendy/, '#e2203d', '#ffffff'], [/^burger king/, '#f5ebdc', '#d62300'], [/^taco bell/, '#702082', '#ffffff'],
  [/^key food/, '#e4002b', '#ffffff'], [/^rite aid/, '#004b8d', '#ffffff'], [/^h&m/, '#e50010', '#ffffff'],
];

export function signStyle(sign) {
  const n = sign.t.toLowerCase();
  const brand = BRANDS.find(([re]) => re.test(n));
  if (brand) return { bg: brand[1], fg: brand[2], brand: true };
  const [bg, fg] = KIND_STYLE[sign.k] || KIND_STYLE.shop;
  return { bg, fg, brand: false };
}

const CELL_W = 512, CELL_H = 64, ATLAS = 2048;
const PER_ATLAS = (ATLAS / CELL_W) * (ATLAS / CELL_H);

function drawSign(g, x, y, w, h, sign, style) {
  g.fillStyle = style.bg;
  g.fillRect(x, y, w, h);
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.lineWidth = 3;
  g.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
  g.fillStyle = style.fg;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  let size = h * 0.62;
  const font = (s) => `700 ${s}px "Helvetica Neue", Arial, sans-serif`;
  g.font = font(size);
  const text = sign.t.length > 42 ? sign.t.slice(0, 40) + '…' : sign.t;
  const maxW = w - h * 0.5;
  const mw = g.measureText(text).width;
  if (mw > maxW) {
    size *= maxW / mw;
    g.font = font(size);
  }
  g.fillText(text, x + w / 2, y + h / 2 + 1);
}

export function buildSigns(signs, renderer) {
  const group = new THREE.Group();
  if (!signs.length) return group;

  // Text faces, one merged mesh per atlas page.
  const pages = Math.ceil(signs.length / PER_ATLAS);
  for (let pg = 0; pg < pages; pg++) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = ATLAS;
    const g = cv.getContext('2d');
    const pos = [], uv = [], nrm = [];
    signs.slice(pg * PER_ATLAS, (pg + 1) * PER_ATLAS).forEach((s, i) => {
      const cx = (i % (ATLAS / CELL_W)) * CELL_W, cy = Math.floor(i / (ATLAS / CELL_W)) * CELL_H;
      // Keep the glyphs' aspect: use only as much of the cell as the sign's proportions need.
      const pw = Math.min(CELL_W, Math.round(CELL_H * (s.w / SIGN_H)));
      drawSign(g, cx, cy, pw, CELL_H, s, signStyle(s));
      const u0 = cx / ATLAS, u1 = (cx + pw) / ATLAS, v1 = 1 - cy / ATLAS, v0 = 1 - (cy + CELL_H) / ATLAS;
      // (tx, ty) is the reader's right when facing the wall from the street (outward normal nx, ny).
      const tx = -s.ny, ty = s.nx;
      const ox = s.x + s.nx * 0.09, oy = s.y + s.ny * 0.09;
      const hw = s.w / 2;
      const L = [ox - tx * hw, oy - ty * hw], R = [ox + tx * hw, oy + ty * hw];
      const y0 = SIGN_BOTTOM, y1 = SIGN_BOTTOM + SIGN_H;
      const quad = [
        [L, y0, u0, v0], [R, y0, u1, v0], [R, y1, u1, v1],
        [L, y0, u0, v0], [R, y1, u1, v1], [L, y1, u0, v1],
      ];
      for (const [p, y, u, v] of quad) {
        pos.push(p[0], y, -p[1]);
        uv.push(u, v);
        nrm.push(s.nx, 0, -s.ny);
      }
    });
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, emissive: '#ffffff', emissiveMap: tex, emissiveIntensity: 0.08 }));
    mesh.name = `signs-${pg}`;
    group.add(mesh);
  }

  // Sign boards (depth) and storefront glazing, instanced.
  const boardGeo = new THREE.BoxGeometry(1, 1, 1);
  const boards = new THREE.InstancedMesh(boardGeo, new THREE.MeshStandardMaterial({ roughness: 0.7 }), signs.length);
  const glassGeo = new THREE.PlaneGeometry(1, 1);
  const glazing = new THREE.InstancedMesh(glassGeo, new THREE.MeshStandardMaterial({ color: '#1d262d', roughness: 0.12, metalness: 0.6 }), signs.length);
  const frameGeo = new THREE.BoxGeometry(1, 1, 1);
  const frames = new THREE.InstancedMesh(frameGeo, new THREE.MeshStandardMaterial({ color: '#2a2a2a', roughness: 0.6 }), signs.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0), c = new THREE.Color();
  signs.forEach((s, i) => {
    q.setFromAxisAngle(up, Math.atan2(s.nx, -s.ny));
    m.compose(p.set(s.x + s.nx * 0.045, SIGN_BOTTOM + SIGN_H / 2, -(s.y + s.ny * 0.045)), q, sc.set(s.w + 0.06, SIGN_H + 0.06, 0.09));
    boards.setMatrixAt(i, m);
    boards.setColorAt(i, c.set(signStyle(s).bg));
    const gw = s.w + 0.6;
    m.compose(p.set(s.x + s.nx * 0.03, 0.35 + (GLAZING_TOP - 0.35) / 2, -(s.y + s.ny * 0.03)), q, sc.set(gw, GLAZING_TOP - 0.35, 1));
    glazing.setMatrixAt(i, m);
    m.compose(p.set(s.x + s.nx * 0.02, 0.35 + (GLAZING_TOP - 0.35) / 2, -(s.y + s.ny * 0.02)), q, sc.set(gw + 0.25, GLAZING_TOP - 0.2, 0.04));
    frames.setMatrixAt(i, m);
  });
  for (const mesh of [boards, glazing, frames]) {
    mesh.castShadow = mesh === boards;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
  }
  group.add(frames, glazing, boards);
  return group;
}
