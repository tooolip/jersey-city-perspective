import * as THREE from 'three';

// Facade textures are greyscale/white so per-building vertex colours tint them.
// One tile = 4 window bays x 4 floors (see BAY_M / FLOOR_M in builders.js).

function canvasTexture(size, draw, renderer) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  draw(g, size);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

function rng(seed) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

// Punched windows in a masonry wall (rowhouses, brownstones, warehouses).
export function masonryTexture(renderer) {
  const rand = rng(42);
  return canvasTexture(512, (g, s) => {
    const cell = s / 4;
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, s, s);
    // subtle brick/mortar noise
    for (let i = 0; i < 6000; i++) {
      const v = 225 + Math.floor(rand() * 30);
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.fillRect(rand() * s, rand() * s, 3 + rand() * 5, 2);
    }
    for (let fx = 0; fx < 4; fx++)
      for (let fy = 0; fy < 4; fy++) {
        const x = fx * cell, y = fy * cell;
        const wx = x + cell * 0.25, ww = cell * 0.5;
        const wy = y + cell * 0.14, wh = cell * 0.56;
        // lintel + sill
        g.fillStyle = '#f4f1ea';
        g.fillRect(wx - 4, wy - 7, ww + 8, 7);
        g.fillRect(wx - 5, wy + wh, ww + 10, 6);
        // glass
        const shade = rand();
        const grd = g.createLinearGradient(0, wy, 0, wy + wh);
        grd.addColorStop(0, shade > 0.85 ? '#8a8676' : '#3a4450');
        grd.addColorStop(1, shade > 0.85 ? '#6f6b5e' : '#1f262e');
        g.fillStyle = grd;
        g.fillRect(wx, wy, ww, wh);
        // frame + muntin
        g.strokeStyle = '#d9d6cf';
        g.lineWidth = 3;
        g.strokeRect(wx, wy, ww, wh);
        g.beginPath();
        g.moveTo(wx, wy + wh * 0.5);
        g.lineTo(wx + ww, wy + wh * 0.5);
        g.stroke();
      }
  }, renderer);
}

// Curtain-wall glass (Newport / Exchange Place towers).
export function glassTexture(renderer) {
  const rand = rng(7);
  return canvasTexture(512, (g, s) => {
    const cell = s / 4;
    for (let fy = 0; fy < 4; fy++) {
      for (let fx = 0; fx < 8; fx++) {
        const v = 150 + Math.floor(rand() * 40);
        g.fillStyle = `rgb(${v - 10},${v},${v + 12})`;
        g.fillRect((fx * cell) / 2, fy * cell, cell / 2, cell);
      }
      // spandrel band at each floor slab
      g.fillStyle = '#dfe3e7';
      g.fillRect(0, fy * cell + cell * 0.82, s, cell * 0.18);
    }
    // mullions
    g.fillStyle = '#7d858c';
    for (let fx = 0; fx <= 8; fx++) g.fillRect((fx * cell) / 2 - 1.5, 0, 3, s);
  }, renderer);
}
