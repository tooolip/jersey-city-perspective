import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { buildWorld } from './world.js';
import { Player } from './player.js';
import { Minimap } from './minimap.js';
import { Inspector } from './inspector.js';
import { Terrain } from './terrain.js';
import { FocusAreas } from './focus.js';
import './style.css';

const $ = (id) => document.getElementById(id);

// Named spots: [label, lat, lon, compass heading]
const PLACES = [
  ['Exchange Place waterfront', 40.7170, -74.0302, 106],
  ['Newport waterfront', 40.7279, -74.0311, 135],
  ['Hamilton Park', 40.7277, -74.0451, 0],
  ['Grove Street PATH', 40.7197, -74.0428, 20],
  ['Holland Tunnel approach', 40.7301, -74.0415, 95],
  ['Sixth Street Embankment', 40.7253, -74.0442, 282],
  ['Newport Centre', 40.7268, -74.0365, 120],
];

const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.62;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
$('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.3, 40000);
const HAZE = new THREE.Color('#c4d0da');
scene.fog = new THREE.FogExp2(HAZE, 0.00018);

// Sky + sun (late-afternoon light from the south-west, which lights up the Manhattan skyline).
const sky = new Sky();
sky.scale.setScalar(35000);
const su = sky.material.uniforms;
su.turbidity.value = 6;
su.rayleigh.value = 1.6;
su.mieCoefficient.value = 0.004;
su.mieDirectionalG.value = 0.8;
const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 32), THREE.MathUtils.degToRad(215));
su.sunPosition.value.copy(sunDir);
scene.add(sky);

const pmrem = new THREE.PMREMGenerator(renderer);
const envScene = new THREE.Scene();
envScene.add(sky.clone());
scene.environment = pmrem.fromScene(envScene, 0, 0.1, 40000).texture;
scene.environmentIntensity = 0.35;

scene.add(new THREE.HemisphereLight('#cfe0ff', '#6b6152', 0.6));
const sun = new THREE.DirectionalLight('#fff1dc', 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
const SHADOW_R = 170;
Object.assign(sun.shadow.camera, { left: -SHADOW_R, right: SHADOW_R, top: SHADOW_R, bottom: -SHADOW_R, near: 10, far: 2000 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.6;
scene.add(sun, sun.target);

function setStatus(text) {
  $('loading-status').textContent = text;
}

async function loadCity() {
  const res = await fetch(`${import.meta.env.BASE_URL}data/city.json`);
  if (!res.ok) throw new Error(`city.json: HTTP ${res.status} (run npm run build:data)`);
  return res.json();
}

function ll2local(meta, lat, lon) {
  const { origin } = meta;
  const mLat = 111132.954 - 559.822 * Math.cos((2 * origin.lat * Math.PI) / 180);
  const mLon = 111412.84 * Math.cos((origin.lat * Math.PI) / 180);
  return [(lon - origin.lon) * mLon, (lat - origin.lat) * mLat];
}

function local2ll(meta, e, n) {
  const { origin } = meta;
  const mLat = 111132.954 - 559.822 * Math.cos((2 * origin.lat * Math.PI) / 180);
  const mLon = 111412.84 * Math.cos((origin.lat * Math.PI) / 180);
  return [origin.lat + n / mLat, origin.lon + e / mLon];
}

setStatus('Downloading map data…');
const data = await loadCity();
setStatus('Building the city…');
await new Promise((r) => setTimeout(r, 30)); // let the status paint
const terrain = await Terrain.load(data.terrain, import.meta.env.BASE_URL, data.focusTerrain || []);
const { root, query, update: updateWorld } = buildWorld(data, renderer, terrain);
scene.add(root);

const player = new Player(camera, renderer.domElement, query, terrain);
const minimap = new Minimap(data, $('minimap'), $('bigmap'));
const inspector = new Inspector($('inspector'), $('crosshair'), query, data);
const focus = new FocusAreas({
  scene, camera, renderer, baseUrl: import.meta.env.BASE_URL,
  hud: (text) => { $('photo-hud').textContent = text || ''; $('photo-hud').classList.toggle('hidden', !text); },
});
await focus.load();

// Place list in the UI
const placeList = $('places');
PLACES.forEach(([label], i) => {
  const li = document.createElement('li');
  li.innerHTML = `<kbd>${i + 1}</kbd> ${label}`;
  placeList.appendChild(li);
});
const goTo = (i) => {
  const [, lat, lon, heading] = PLACES[i];
  const [e, n] = ll2local(data.meta, lat, lon);
  player.teleport(e, n, heading);
};
goTo(0);

// Overlay / pointer lock handling
let mapOpen = false;
let mapPick = null;
const overlay = $('overlay');
overlay.addEventListener('click', () => player.lock());
player.onLockChange = (locked) => {
  overlay.classList.toggle('hidden', locked || mapOpen);
};
player.onModeChange = (fly) => {
  $('mode').textContent = fly ? 'Flying' : 'Walking';
};
$('loading').classList.add('hidden');
overlay.classList.remove('hidden');

function setMap(open) {
  mapOpen = open;
  $('bigmap-wrap').classList.toggle('hidden', !open);
  if (open) {
    document.exitPointerLock?.();
    overlay.classList.add('hidden');
  } else {
    player.lock();
  }
}
window.addEventListener('keydown', (ev) => {
  if (ev.code === 'KeyM') setMap(!mapOpen);
  if (ev.code === 'KeyI') inspector.toggle();
  if (ev.code === 'KeyK') focus.toggleCloud();
  if (ev.code === 'KeyP') focus.nextPhoto(player.e, player.n, ev.shiftKey ? -1 : 1);
  if (ev.code === 'KeyO') focus.cycleOpacity();
  if (ev.code === 'KeyX') focus.exitPhoto();
  if (ev.code === 'Escape' && mapOpen) setMap(false);
  const digit = /^Digit([1-9])$/.exec(ev.code);
  if (digit && PLACES[digit[1] - 1]) goTo(digit[1] - 1);
});
$('bigmap').addEventListener('click', (ev) => {
  if (!mapPick) return;
  const [e, n] = mapPick(ev.clientX, ev.clientY);
  player.teleport(e, n);
  setMap(false);
});

// Checked every frame: the page can load while its window still has no size.
function fitToWindow() {
  const size = renderer.getSize(new THREE.Vector2());
  if (size.x === innerWidth && size.y === innerHeight) return;
  camera.aspect = innerWidth / Math.max(1, innerHeight);
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}

// Main loop
const timer = new THREE.Timer();
let hudTimer = 0, frames = 0, fpsTime = 0;
renderer.setAnimationLoop((time) => {
  timer.update(time);
  const dt = Math.min(0.1, timer.getDelta());
  fitToWindow();
  if (focus.photoMode) focus.applyCamera();
  else player.update(dt);
  updateWorld(time / 1000);

  // Shadow camera follows the player, snapped to texels to avoid shimmering.
  const texel = (SHADOW_R * 2) / sun.shadow.mapSize.x;
  const cx = Math.round(camera.position.x / texel) * texel, cz = Math.round(camera.position.z / texel) * texel;
  const gy = terrain.height(cx, -cz);
  sun.target.position.set(cx, gy, cz);
  sun.position.set(cx + sunDir.x * 800, gy + sunDir.y * 800, cz + sunDir.z * 800);

  renderer.render(scene, camera);

  frames++;
  fpsTime += dt;
  hudTimer += dt;
  if (hudTimer > 0.15) {
    hudTimer = 0;
    const street = query.streetAt(player.e, player.n);
    const area = query.inBounds(player.e, player.n, 0) ? 'Downtown Jersey City' : 'Outside project area';
    $('street').textContent = player.y - terrain.height(player.e, player.n) > 40 ? `Above ${street || area}` : street || area;
    const [lat, lon] = local2ll(data.meta, player.e, player.n);
    const compass = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(player.heading / 45) % 8];
    $('coords').textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)} · ${compass} ${Math.round(player.heading)}°${player.fly ? ` · ${Math.round(player.y - terrain.height(player.e, player.n))} m up` : ` · ground ${terrain.height(player.e, player.n).toFixed(1)} m`}`;
    minimap.update(player.e, player.n, player.heading);
    inspector.update(camera);
    if (mapOpen) mapPick = minimap.drawBig(player.e, player.n, player.heading);
  }
  if (fpsTime > 1) {
    $('fps').textContent = `${Math.round(frames / fpsTime)} fps`;
    frames = 0;
    fpsTime = 0;
  }
});

// Handy for debugging from the console.
Object.assign(window, { THREE, scene, camera, player, query, data, renderer, inspector, terrain, focus, ll: (lat, lon) => ll2local(data.meta, lat, lon) });
