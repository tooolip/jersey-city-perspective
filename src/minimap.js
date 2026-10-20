import { toPts, bbox } from './geo.js';

const PX_PER_M = 1.2; // resolution of the pre-rendered base map

// North-up map: a small corner view that follows the player, and a full-screen view
// (M) where clicking teleports.
export class Minimap {
  constructor(data, smallCanvas, bigCanvas) {
    this.small = smallCanvas;
    this.big = bigCanvas;
    const pts = toPts(data.boundary);
    const [x0, y0, x1, y1] = bbox(pts);
    const pad = 380;
    this.bounds = [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
    this.base = this.renderBase(data);
  }

  toPx(x, y) {
    return [(x - this.bounds[0]) * PX_PER_M, (this.bounds[3] - y) * PX_PER_M];
  }

  renderBase(data) {
    const [x0, y0, x1, y1] = this.bounds;
    const cv = document.createElement('canvas');
    cv.width = Math.ceil((x1 - x0) * PX_PER_M);
    cv.height = Math.ceil((y1 - y0) * PX_PER_M);
    const g = cv.getContext('2d');
    g.fillStyle = '#d9d5cc';
    g.fillRect(0, 0, cv.width, cv.height);
    const poly = (flat, holes = []) => {
      g.beginPath();
      for (const ring of [flat, ...holes]) {
        for (let i = 0; i < ring.length; i += 2) {
          const [px, py] = this.toPx(ring[i], ring[i + 1]);
          i ? g.lineTo(px, py) : g.moveTo(px, py);
        }
        g.closePath();
      }
      g.fill('evenodd');
    };
    const line = (flat, w) => {
      g.lineWidth = Math.max(0.8, w * PX_PER_M);
      g.beginPath();
      for (let i = 0; i < flat.length; i += 2) {
        const [px, py] = this.toPx(flat[i], flat[i + 1]);
        i ? g.lineTo(px, py) : g.moveTo(px, py);
      }
      g.stroke();
    };
    g.fillStyle = '#9cc3d6';
    for (const w of data.water) poly(w.o, w.holes);
    const AREA = { park: '#b5d39a', grass: '#c3daa5', wood: '#9fc283', pitch: '#a9d08f', playground: '#e2d4a8', pier: '#cfc6b6', sand: '#eadcb0' };
    for (const a of data.areas) {
      if (!AREA[a.k]) continue;
      g.fillStyle = AREA[a.k];
      poly(a.o, a.holes);
    }
    g.strokeStyle = '#ffffff';
    g.lineCap = g.lineJoin = 'round';
    for (const r of data.roads) line(r.p, r.w);
    g.strokeStyle = '#a07aa8';
    for (const r of data.rails) line(r.p, 1.5);
    g.fillStyle = '#a19a8f';
    for (const b of data.buildings) poly(b.o);
    g.fillStyle = '#b5aea4';
    for (const b of data.skyline) poly(b.o);
    g.strokeStyle = 'rgba(200,40,40,0.75)';
    g.setLineDash([10, 6]);
    line([...data.boundary, data.boundary[0], data.boundary[1]], 2.5);
    g.setLineDash([]);
    return cv;
  }

  drawPlayer(g, x, y, heading, size) {
    g.save();
    g.translate(x, y);
    g.rotate((heading * Math.PI) / 180);
    g.fillStyle = '#e8492f';
    g.strokeStyle = '#fff';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(0, -size);
    g.lineTo(size * 0.7, size * 0.8);
    g.lineTo(0, size * 0.4);
    g.lineTo(-size * 0.7, size * 0.8);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
  }

  update(e, n, heading) {
    const cv = this.small;
    const g = cv.getContext('2d');
    const s = cv.width;
    const [px, py] = this.toPx(e, n);
    const zoom = 1.6; // screen px per base px
    g.save();
    g.clearRect(0, 0, s, s);
    g.beginPath();
    g.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = '#d9d5cc';
    g.fillRect(0, 0, s, s);
    g.imageSmoothingEnabled = true;
    const src = s / zoom;
    g.drawImage(this.base, px - src / 2, py - src / 2, src, src, 0, 0, s, s);
    this.drawPlayer(g, s / 2, s / 2, heading, 9);
    g.restore();
  }

  // Full-screen map. Returns a function mapping a click to [east, north].
  drawBig(e, n, heading) {
    const cv = this.big;
    cv.width = cv.clientWidth * devicePixelRatio;
    cv.height = cv.clientHeight * devicePixelRatio;
    const g = cv.getContext('2d');
    const scale = Math.min(cv.width / this.base.width, cv.height / this.base.height);
    const ox = (cv.width - this.base.width * scale) / 2, oy = (cv.height - this.base.height * scale) / 2;
    g.fillStyle = '#d9d5cc';
    g.fillRect(0, 0, cv.width, cv.height);
    g.drawImage(this.base, ox, oy, this.base.width * scale, this.base.height * scale);
    const [px, py] = this.toPx(e, n);
    this.drawPlayer(g, ox + px * scale, oy + py * scale, heading, 12 * devicePixelRatio);
    return (clientX, clientY) => {
      const r = cv.getBoundingClientRect();
      const bx = ((clientX - r.left) * devicePixelRatio - ox) / scale;
      const by = ((clientY - r.top) * devicePixelRatio - oy) / scale;
      return [bx / PX_PER_M + this.bounds[0], this.bounds[3] - by / PX_PER_M];
    };
  }
}
