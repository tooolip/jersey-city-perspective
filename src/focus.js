import * as THREE from 'three';

// Focus areas: places refined with Mapillary 3D data. Each brings the real photos with their
// camera poses (photo-match view) and the photos' SfM point cloud (truth overlay).

const OPACITY_STEPS = [0.5, 0.85, 0];

// Photo-textured walls for every focus area: { map: "buildingId:edge" -> wall, textures: [...] }.
export async function loadPhotoFacades(baseUrl, renderer) {
  const map = new Map(), textures = [];
  try {
    const res = await fetch(`${baseUrl}data/focus/index.json`);
    if (!res.ok) return { map, textures };
    const loader = new THREE.TextureLoader();
    for (const name of await res.json()) {
      const r = await fetch(`${baseUrl}data/focus/${name}/facades.json`);
      if (!r.ok) continue;
      const fac = await r.json();
      const first = textures.length;
      for (let i = 0; i < fac.pages; i++) {
        const tex = await loader.loadAsync(`${baseUrl}data/focus/${name}/facades-${i}.jpg`);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
        textures.push(tex);
      }
      for (const w of fac.walls) map.set(`${w.id}:${w.edge}`, { ...w, page: first + w.page, area: name });
    }
  } catch {
    /* no photo facades */
  }
  return { map, textures };
}

export class FocusAreas {
  constructor({ scene, camera, renderer, baseUrl, hud }) {
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    this.baseUrl = baseUrl;
    this.hud = hud;
    this.areas = [];
    this.photoMode = null; // { area, list, i }
    this.opacity = 0;
    this.overlay = document.createElement('img');
    this.overlay.id = 'photo-overlay';
    this.overlay.className = 'hidden';
    document.body.appendChild(this.overlay);
  }

  async load() {
    try {
      const res = await fetch(`${this.baseUrl}data/focus/index.json`);
      if (!res.ok) return;
      for (const name of await res.json()) {
        const r = await fetch(`${this.baseUrl}data/focus/${name}/focus.json`);
        if (!r.ok) continue;
        const area = await r.json();
        area.cloud = this.buildCloud(area);
        this.scene.add(area.cloud);
        this.areas.push(area);
      }
    } catch {
      /* no focus areas */
    }
  }

  buildCloud(area) {
    const p = area.points.p, c = area.points.c;
    const pos = new Float32Array(p.length), col = new Float32Array(c.length);
    for (let i = 0; i < p.length; i += 3) {
      pos[i] = p[i];
      pos[i + 1] = p[i + 2];
      pos[i + 2] = -p[i + 1];
    }
    const tmp = new THREE.Color();
    for (let i = 0; i < c.length; i += 3) {
      tmp.setRGB(c[i] / 255, c[i + 1] / 255, c[i + 2] / 255, THREE.SRGBColorSpace);
      col.set([tmp.r, tmp.g, tmp.b], i);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.35, vertexColors: true, sizeAttenuation: true }));
    pts.visible = false;
    pts.name = `sfm-${area.name}`;
    return pts;
  }

  toggleCloud() {
    for (const a of this.areas) a.cloud.visible = !a.cloud.visible;
    return this.areas.some((a) => a.cloud.visible);
  }

  nearestArea(e, n) {
    let best = null, bd = Infinity;
    for (const a of this.areas) {
      const d = Math.hypot(a.center[0] - e, a.center[1] - n);
      if (d < bd) { bd = d; best = a; }
    }
    return bd < 400 ? best : null;
  }

  // Photo-match: put the camera exactly where a real photo was taken and overlay it.
  nextPhoto(e, n, step = 1) {
    if (!this.photoMode) {
      const area = this.nearestArea(e, n);
      if (!area?.photos.length) return false;
      const list = [...area.photos].sort((a, b) => Math.hypot(a.e - e, a.n - n) - Math.hypot(b.e - e, b.n - n));
      this.photoMode = { area, list, i: 0 };
      if (!this.opacity) this.opacity = OPACITY_STEPS[0];
    } else {
      const m = this.photoMode;
      m.i = (m.i + step + m.list.length) % m.list.length;
    }
    this.showPhoto();
    return true;
  }

  showPhoto() {
    const { area, list, i } = this.photoMode;
    const ph = list[i];
    this.overlay.src = `${this.baseUrl}data/focus/${area.name}/photos/${ph.id}.jpg`;
    this.overlay.style.opacity = this.opacity;
    this.overlay.classList.toggle('hidden', !this.opacity);
    this.hud?.(`Photo ${i + 1}/${list.length} · ${ph.yr} · Mapillary ${ph.id} · O opacity · P/⇧P next/prev · X exit`);
  }

  cycleOpacity() {
    if (!this.photoMode) return;
    const k = OPACITY_STEPS.indexOf(this.opacity);
    this.opacity = OPACITY_STEPS[(k + 1) % OPACITY_STEPS.length];
    this.showPhoto();
  }

  exitPhoto() {
    if (!this.photoMode) return false;
    this.photoMode = null;
    this.overlay.classList.add('hidden');
    this.hud?.(null);
    const r = this.renderer;
    r.setScissorTest(false);
    r.setViewport(0, 0, innerWidth, innerHeight);
    this.camera.fov = 70;
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    return true;
  }

  // Called every frame while in photo mode instead of the player's camera update.
  applyCamera() {
    const ph = this.photoMode.list[this.photoMode.i];
    const cam = this.camera;
    cam.position.set(ph.e, ph.z, -ph.n);
    cam.quaternion.set(ph.q[0], ph.q[1], ph.q[2], ph.q[3]);
    cam.fov = ph.vfov;
    cam.aspect = ph.aspect;
    cam.updateProjectionMatrix();
    // Letterbox the render to the photo's aspect so the overlay lines up pixel for pixel.
    let w = innerWidth, h = innerWidth / ph.aspect;
    if (h > innerHeight) { h = innerHeight; w = h * ph.aspect; }
    const x = (innerWidth - w) / 2, y = (innerHeight - h) / 2;
    const r = this.renderer;
    r.setScissorTest(true);
    r.setScissor(x, y, w, h);
    r.setViewport(x, y, w, h);
    Object.assign(this.overlay.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
  }
}
