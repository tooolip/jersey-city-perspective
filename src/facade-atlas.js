import * as THREE from 'three';

// Facade atlas: each row is one storey of a kit, 4 window bays wide. Alpha marks "wall" (255,
// tinted by the building's facade colour) versus details (128) that keep their own colour:
// glass, frames, lintels, doors. See facadeMaterial() for how it's sampled.

const CELL = 256; // px per bay and per storey
const ROWS = 16;
export const KIT_ROWS = {
  rowhouse: [0, 1], frame: [2, 3], warehouse: [4, 5], midcentury: [6, 7], modern: [8, 9], glass: [10, 11], storefront: [12, 12],
};

function rng(seed) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

function glassGrad(g, X, Y, W, H, r) {
  const grd = g.createLinearGradient(X, Y, X + W * 0.3, Y + H);
  const lit = r > 0.9, curtain = r > 0.75 && !lit;
  // Daytime glass reflects the street and sky: mid blue-grey, darker towards the bottom.
  grd.addColorStop(0, lit ? '#a59a80' : curtain ? '#b3a993' : '#7d8b97');
  grd.addColorStop(1, lit ? '#857b66' : curtain ? '#948b78' : '#3e4852');
  return grd;
}

export function facadeAtlas(renderer) {
  const color = document.createElement('canvas');
  color.width = CELL * 4;
  color.height = CELL * ROWS;
  const g = color.getContext('2d');
  const masks = []; // detail rectangles / paths to clear alpha on
  const rand = rng(11);

  // Wall base: near-white with a faint masonry or siding texture (alpha 1 = tinted).
  const wallRow = (row, kind) => {
    const y0 = row * CELL;
    g.fillStyle = '#f3f2ef';
    g.fillRect(0, y0, CELL * 4, CELL);
    if (kind === 'brick') {
      for (let y = 0; y < CELL; y += 8) {
        g.fillStyle = 'rgba(0,0,0,0.05)';
        g.fillRect(0, y0 + y, CELL * 4, 1.5);
        for (let x = (y / 8) % 2 ? 0 : 12; x < CELL * 4; x += 24) g.fillRect(x, y0 + y, 1.5, 8);
      }
      for (let i = 0; i < 900; i++) {
        const v = 225 + Math.floor(rand() * 30);
        g.fillStyle = `rgb(${v},${v},${v})`;
        g.fillRect(rand() * CELL * 4, y0 + rand() * CELL, 10, 6);
      }
    } else if (kind === 'siding') {
      for (let y = 0; y < CELL; y += CELL / 14) {
        g.fillStyle = 'rgba(0,0,0,0.13)';
        g.fillRect(0, y0 + y, CELL * 4, 2);
        g.fillStyle = 'rgba(255,255,255,0.5)';
        g.fillRect(0, y0 + y + 2, CELL * 4, 1);
      }
    } else if (kind === 'panel') {
      g.fillStyle = 'rgba(0,0,0,0.08)';
      for (let x = 0; x < CELL * 4; x += CELL / 2) g.fillRect(x, y0, 2, CELL);
      g.fillRect(0, y0 + CELL - 3, CELL * 4, 3);
    }
  };
  const detail = (row, bay, x, y, w, h, fill) => {
    const X = bay * CELL + x * CELL, Y = row * CELL + y * CELL, W = w * CELL, H = h * CELL;
    g.fillStyle = typeof fill === 'function' ? fill(X, Y, W, H) : fill;
    g.fillRect(X, Y, W, H);
    masks.push([X, Y, W, H]);
    return [X, Y, W, H];
  };
  const sash = (row, bay, x, y, w, h, frame, panes = 2) => {
    const r = rand();
    detail(row, bay, x - 0.05, y - 0.035, w + 0.1, h + 0.07, frame);
    const [X, Y, W, H] = detail(row, bay, x, y, w, h, (X1, Y1, W1, H1) => glassGrad(g, X1, Y1, W1, H1, r));
    g.fillStyle = frame;
    g.fillRect(X, Y + H / 2 - 4, W, 8); // meeting rail
    if (panes > 1) g.fillRect(X + W / 2 - 3, Y, 6, H);
  };

  // 0/1 rowhouse: tall 2-over-2 sash windows with stone lintels and sills; door bay on the ground floor.
  wallRow(0, 'brick');
  wallRow(1, 'brick');
  for (let b = 0; b < 4; b++) {
    for (const row of [0, 1]) {
      if (row === 0 && b === 0) {
        detail(0, 0, 0.14, 0.04, 0.72, 0.96, '#d2c6b0'); // stone door surround
        detail(0, 0, 0.12, 0.02, 0.76, 0.06, '#b9ad97'); // hood
        detail(0, 0, 0.24, 0.12, 0.52, 0.15, (X, Y, W, H) => glassGrad(g, X, Y, W, H, 0)); // transom
        detail(0, 0, 0.24, 0.3, 0.52, 0.7, '#6b2f24'); // painted double door
        detail(0, 0, 0.27, 0.35, 0.21, 0.28, '#7d3a2d');
        detail(0, 0, 0.52, 0.35, 0.21, 0.28, '#7d3a2d');
        detail(0, 0, 0.27, 0.68, 0.21, 0.26, '#7d3a2d');
        detail(0, 0, 0.52, 0.68, 0.21, 0.26, '#7d3a2d');
        detail(0, 0, 0.495, 0.3, 0.02, 0.7, '#4a1f18');
        continue;
      }
      detail(row, b, 0.2, 0.08, 0.6, 0.09, '#d2c6b0'); // lintel
      sash(row, b, 0.28, 0.2, 0.44, 0.6, '#ece7dc');
      detail(row, b, 0.21, 0.82, 0.58, 0.05, '#d2c6b0'); // sill
    }
  }
  // 2/3 frame: clapboard, smaller windows with white trim, door on the ground floor.
  wallRow(2, 'siding');
  wallRow(3, 'siding');
  for (let b = 0; b < 4; b++) {
    for (const row of [2, 3]) {
      if (row === 2 && b === 0) {
        detail(2, 0, 0.22, 0.2, 0.56, 0.8, '#f1eee6');
        detail(2, 0, 0.29, 0.26, 0.42, 0.74, '#5a4636');
        continue;
      }
      detail(row, b, 0.24, 0.16, 0.52, 0.66, '#f4f1ea'); // trim
      sash(row, b, 0.29, 0.21, 0.42, 0.56, '#f4f1ea');
    }
  }
  // 4/5 warehouse: wide segmental-arched multi-pane windows between brick piers.
  wallRow(4, 'brick');
  wallRow(5, 'brick');
  const warehouseWindow = (row, b, y, h) => {
    const X = b * CELL + 0.12 * CELL, Y = row * CELL + y * CELL, W = 0.76 * CELL, H = h * CELL;
    g.fillStyle = '#cbbfa9';
    g.beginPath();
    g.ellipse(X + W / 2, Y + 4, W / 2 + 10, 22, 0, Math.PI, 0);
    g.fill();
    masks.push([X - 10, Y - 20, W + 20, 26]);
    detail(row, b, 0.12, y, 0.76, h, (X1, Y1, W1, H1) => glassGrad(g, X1, Y1, W1, H1, rand()));
    g.fillStyle = '#3d3a36';
    for (let i = 1; i < 4; i++) g.fillRect(X + (W * i) / 4 - 1.5, Y, 3, H);
    for (let j = 1; j < 4; j++) g.fillRect(X, Y + (H * j) / 4 - 1.5, W, 3);
  };
  for (let b = 0; b < 4; b++) {
    warehouseWindow(4, b, 0.2, 0.75);
    warehouseWindow(5, b, 0.18, 0.62);
  }
  // 6/7 mid-century: plain wall, wide windows with thin aluminium frames; glass entrance.
  wallRow(6, 'panel');
  wallRow(7, 'panel');
  for (let b = 0; b < 4; b++) {
    if (b === 0) {
      detail(6, 0, 0.06, 0.15, 0.88, 0.85, '#7b7f82');
      detail(6, 0, 0.1, 0.18, 0.8, 0.82, (X, Y, W, H) => glassGrad(g, X, Y, W, H, 0));
    } else {
      detail(6, b, 0.12, 0.28, 0.76, 0.42, '#a7aaac');
      detail(6, b, 0.14, 0.3, 0.72, 0.38, (X, Y, W, H) => glassGrad(g, X, Y, W, H, rand()));
    }
    detail(7, b, 0.08, 0.28, 0.84, 0.44, '#a7aaac');
    const [X, Y, W, H] = detail(7, b, 0.1, 0.3, 0.8, 0.4, (X1, Y1, W1, H1) => glassGrad(g, X1, Y1, W1, H1, rand()));
    g.fillStyle = '#a7aaac';
    g.fillRect(X + W / 2 - 1.5, Y, 3, H);
  }
  // 8/9 modern: large windows, panel joints, some with balcony rails.
  wallRow(8, 'panel');
  wallRow(9, 'panel');
  for (let b = 0; b < 4; b++) {
    detail(8, b, 0.04, 0.12, 0.92, 0.88, (X, Y, W, H) => glassGrad(g, X, Y, W, H, 0.2));
    g.fillStyle = '#2f3336';
    g.fillRect(b * CELL + CELL / 2 - 2, 8 * CELL + 0.12 * CELL, 4, 0.88 * CELL);
    detail(9, b, 0.1, 0.1, 0.8, 0.72, '#2f3336');
    detail(9, b, 0.12, 0.12, 0.76, 0.68, (X, Y, W, H) => glassGrad(g, X, Y, W, H, rand()));
    if (b % 2 === 0) {
      detail(9, b, 0.06, 0.62, 0.88, 0.03, '#2a2d30');
      detail(9, b, 0.06, 0.8, 0.88, 0.03, '#2a2d30');
    }
  }
  // 10/11 glass curtain wall: the glass itself is "wall" (tinted), mullions and spandrels are detail.
  for (const row of [10, 11]) {
    const y0 = row * CELL;
    for (let x = 0; x < 8; x++) {
      const v = 175 + Math.floor(rand() * 45);
      g.fillStyle = `rgb(${v},${v},${v + 6})`;
      g.fillRect((x * CELL) / 2, y0, CELL / 2, CELL);
    }
    if (row === 11) detail(row, 0, 0, 0.82, 4, 0.18, '#d7dbdf'); // spandrel band (full row)
    g.fillStyle = '#7d858c';
    for (let x = 0; x <= 8; x++) {
      g.fillRect((x * CELL) / 2 - 2, y0, 4, CELL);
      masks.push([(x * CELL) / 2 - 2, y0, 4, CELL]);
    }
  }
  // 12 storefront: sign band, transom, display glass, bulkhead; door in bay 1.
  wallRow(12, 'brick');
  for (let b = 0; b < 4; b++) {
    detail(12, b, 0, 0.0, 1, 0.1, '#2e2b29');
    detail(12, b, 0.03, 0.12, 0.94, 0.86, '#37332f');
    detail(12, b, 0.06, 0.14, 0.88, 0.12, (X, Y, W, H) => glassGrad(g, X, Y, W, H, 0));
    if (b === 1) detail(12, b, 0.3, 0.3, 0.4, 0.68, '#2a2522');
    else detail(12, b, 0.06, 0.3, 0.88, 0.5, (X, Y, W, H) => glassGrad(g, X, Y, W, H, rand() * 0.95));
    detail(12, b, 0.03, 0.82, 0.94, 0.16, '#4a4440');
  }

  // Alpha: wall = 255, detail = 128. (Not 0: canvases store premultiplied colour, so a fully
  // transparent pixel would lose its RGB.)
  const img = g.getImageData(0, 0, color.width, color.height);
  const alpha = document.createElement('canvas');
  alpha.width = color.width;
  alpha.height = color.height;
  const ag = alpha.getContext('2d');
  ag.fillStyle = '#fff';
  ag.fillRect(0, 0, alpha.width, alpha.height);
  ag.fillStyle = '#808080';
  for (const [x, y, w, h] of masks) ag.fillRect(Math.floor(x), Math.floor(y), Math.ceil(w) + 1, Math.ceil(h) + 1);
  const a = ag.getImageData(0, 0, alpha.width, alpha.height).data;
  for (let i = 0; i < img.data.length; i += 4) img.data[i + 3] = a[i];
  g.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(color);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.premultiplyAlpha = false;
  return tex;
}

// MeshStandardMaterial that samples the atlas per storey: uv = (bays, storeys) along each wall,
// attribute `kit` = (ground-floor row, upper-floor row). Wall pixels are tinted by vertex colour.
export function facadeMaterial(atlas, params = {}) {
  const mat = new THREE.MeshStandardMaterial({ map: atlas, vertexColors: true, ...params });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 kit;\nvarying vec2 vKit;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvKit = kit;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec2 vKit;\nconst float ROWS = ${ROWS.toFixed(1)};`)
      .replace(
        '#include <map_fragment>',
        `
        vec2 fu = vMapUv;
        float storey = floor(fu.y + 1e-3);
        float row = storey < 0.5 ? vKit.x : vKit.y;
        vec2 cellUv = vec2(fract(fu.x * 0.25), 1.0 - (row + 1.0) / ROWS + fract(fu.y) / ROWS);
        vec2 g = vec2(0.25, 1.0 / ROWS);
        vec4 texel = textureGrad(map, cellUv, dFdx(fu) * g, dFdy(fu) * g);
        float wallMask = step(0.75, texel.a);
        diffuseColor.rgb *= mix(texel.rgb, texel.rgb * vColor.rgb, wallMask);
        `,
      )
      .replace('#include <color_fragment>', '');
  };
  mat.customProgramCacheKey = () => 'facade-atlas';
  return mat;
}
