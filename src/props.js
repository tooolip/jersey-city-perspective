import * as THREE from 'three';
import { hash01 } from './geo.js';
import { ground } from './builders.js';

const CANOPY = ['#4f6f3a', '#5c7d3f', '#476536', '#6a8a45', '#3f5c33', '#587a48'].map((c) => new THREE.Color(c));

// Street and park trees: one instanced trunk mesh and one instanced canopy mesh.
// flat is [east, north, ...] or, with stride 3, [east, north, baseHeight, ...].
export function buildTrees(flat, stride = 2, seed = 0) {
  const n = flat.length / stride;
  const trunkGeo = new THREE.CylinderGeometry(0.14, 0.22, 1, 6);
  trunkGeo.translate(0, 0.5, 0);
  const canopyGeo = new THREE.IcosahedronGeometry(1, 1);
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: '#4a3b2f', roughness: 1 }), n);
  const canopies = new THREE.InstancedMesh(canopyGeo, new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }), n);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < n; i++) {
    const e = flat[i * stride], north = flat[i * stride + 1], base = stride > 2 ? flat[i * stride + 2] : ground(e, north);
    const h = i + seed;
    const r1 = hash01(h * 3 + 1), r2 = hash01(h * 3 + 2), r3 = hash01(h * 3 + 3);
    const trunkH = 2.2 + r1 * 2.2;
    const crown = 2.2 + r2 * 2.6;
    m.compose(p.set(e, base, -north), q.identity(), s.set(1 + r3 * 0.5, trunkH + crown * 0.6, 1 + r3 * 0.5));
    trunks.setMatrixAt(i, m);
    q.setFromAxisAngle(up, r3 * Math.PI * 2);
    m.compose(p.set(e, base + trunkH + crown * 0.85, -north), q, s.set(crown, crown * (0.85 + r1 * 0.35), crown));
    canopies.setMatrixAt(i, m);
    canopies.setColorAt(i, CANOPY[Math.floor(r2 * CANOPY.length)]);
  }
  for (const mesh of [trunks, canopies]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
  }
  const group = new THREE.Group();
  group.add(trunks, canopies);
  return group;
}

// Trees measured by LiDAR: [east, north, ground z, height, crown radius] per tree.
export function buildMeasuredTrees(flat) {
  const n = flat.length / 5;
  const trunkGeo = new THREE.CylinderGeometry(0.14, 0.22, 1, 6);
  trunkGeo.translate(0, 0.5, 0);
  const canopyGeo = new THREE.IcosahedronGeometry(1, 1);
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: '#4a3b2f', roughness: 1 }), n);
  const canopies = new THREE.InstancedMesh(canopyGeo, new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }), n);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < n; i++) {
    const [e, north, z, h, r] = flat.slice(i * 5, i * 5 + 5);
    const r1 = hash01(i * 3 + 7), r2 = hash01(i * 3 + 8);
    // Crown: measured spread; depth about 0.8 of the spread, never taller than the tree allows.
    const rv = Math.min(r * 0.8, h * 0.42);
    const cy = z + h - rv;
    const trunkW = 0.6 + Math.min(1.6, h / 12);
    m.compose(p.set(e, z, -north), q.identity(), s.set(trunkW, Math.max(1, cy - z + rv * 0.3), trunkW));
    trunks.setMatrixAt(i, m);
    q.setFromAxisAngle(up, r1 * Math.PI * 2);
    m.compose(p.set(e, cy, -north), q, s.set(r, rv, r * (0.9 + r2 * 0.2)));
    canopies.setMatrixAt(i, m);
    canopies.setColorAt(i, CANOPY[Math.floor(r2 * CANOPY.length)]);
  }
  for (const mesh of [trunks, canopies]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
  }
  const group = new THREE.Group();
  group.add(trunks, canopies);
  group.name = 'trees-lidar';
  return group;
}

// Simple street lamps: a dark pole with a lantern head.
export function buildLamps(flat) {
  const n = flat.length / 2;
  const poleGeo = new THREE.CylinderGeometry(0.07, 0.1, 5.2, 6);
  poleGeo.translate(0, 2.6, 0);
  const headGeo = new THREE.CylinderGeometry(0.28, 0.16, 0.6, 6);
  headGeo.translate(0, 5.4, 0);
  const poles = new THREE.InstancedMesh(poleGeo, new THREE.MeshStandardMaterial({ color: '#23282a', roughness: 0.6, metalness: 0.4 }), n);
  const heads = new THREE.InstancedMesh(headGeo, new THREE.MeshStandardMaterial({ color: '#2c3133', emissive: '#fff1c8', emissiveIntensity: 0.15 }), n);
  const m = new THREE.Matrix4();
  for (let i = 0; i < n; i++) {
    m.makeTranslation(flat[i * 2], ground(flat[i * 2], flat[i * 2 + 1]), -flat[i * 2 + 1]);
    poles.setMatrixAt(i, m);
    heads.setMatrixAt(i, m);
  }
  poles.castShadow = true;
  for (const mesh of [poles, heads]) mesh.computeBoundingSphere();
  const group = new THREE.Group();
  group.add(poles, heads);
  return group;
}
