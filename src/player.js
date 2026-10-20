import * as THREE from 'three';

const EYE = 1.7;
const WALK = 4.2, RUN = 11; // m/s (a brisk walk / a jog-and-then-some)
const FLY = 35, FLY_FAST = 140;
const GRAVITY = 22, JUMP = 6.5;
const RADIUS = 0.35;

// First-person controller. Position is stored in [east, north]; three.js z = -north.
export class Player {
  constructor(camera, dom, query) {
    this.camera = camera;
    this.dom = dom;
    this.query = query;
    this.e = 0;
    this.n = 0;
    this.y = EYE;
    this.vy = 0;
    this.yaw = 0; // 0 = facing north, positive = turning left (west)
    this.pitch = 0;
    this.fly = false;
    this.keys = new Set();
    this.vel = new THREE.Vector2();
    this.locked = false;
    camera.rotation.order = 'YXZ';

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === dom;
      this.onLockChange?.(this.locked);
    });
    document.addEventListener('mousemove', (ev) => {
      if (!this.locked) return;
      this.yaw -= ev.movementX * 0.0022;
      this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - ev.movementY * 0.0022));
    });
    window.addEventListener('keydown', (ev) => {
      if (ev.target instanceof HTMLInputElement) return;
      this.keys.add(ev.code);
      if (ev.code === 'KeyF') this.toggleFly();
      if (ev.code === 'Space' && !this.fly && this.y <= EYE + 1e-3) this.vy = JUMP;
    });
    window.addEventListener('keyup', (ev) => this.keys.delete(ev.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  lock() {
    this.dom.requestPointerLock?.();
  }

  // heading: compass degrees (0 = north, 90 = east)
  teleport(e, n, heading = null) {
    [this.e, this.n] = this.query.nearestWalkable(e, n);
    if (!this.fly) this.y = EYE;
    if (heading !== null) {
      this.yaw = (-heading * Math.PI) / 180;
      this.pitch = 0;
    }
    this.vel.set(0, 0);
  }

  get heading() {
    return ((((-this.yaw * 180) / Math.PI) % 360) + 360) % 360;
  }

  toggleFly() {
    this.fly = !this.fly;
    if (this.fly) {
      this.y = Math.max(this.y, 40);
    } else {
      [this.e, this.n] = this.query.nearestWalkable(this.e, this.n);
      this.y = EYE;
      this.vy = 0;
    }
    this.onModeChange?.(this.fly);
  }

  update(dt) {
    const k = this.keys;
    const fwd = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const side = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const fast = k.has('ShiftLeft') || k.has('ShiftRight');
    const speed = this.fly ? (fast ? FLY_FAST : FLY) : fast ? RUN : WALK;

    // Desired velocity in [east, north]. Facing north at yaw 0; yaw rotates CCW.
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    let de = -sy * fwd + cy * side;
    let dn = cy * fwd + sy * side;
    const len = Math.hypot(de, dn);
    if (len > 0) { de = (de / len) * speed; dn = (dn / len) * speed; }
    const accel = this.fly ? 4 : 10;
    this.vel.x += (de - this.vel.x) * Math.min(1, accel * dt);
    this.vel.y += (dn - this.vel.y) * Math.min(1, accel * dt);

    const ne = this.e + this.vel.x * dt, nn = this.n + this.vel.y * dt;
    if (this.fly) {
      this.e = ne;
      this.n = nn;
      const up = (k.has('KeyE') || k.has('Space') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);
      this.y = Math.max(EYE, this.y + up * speed * 0.6 * dt);
    } else {
      // Slide along walls: try the full step, then each axis on its own.
      const q = this.query;
      if (q.isWalkable(ne, nn, RADIUS)) { this.e = ne; this.n = nn; }
      else if (q.isWalkable(ne, this.n, RADIUS)) { this.e = ne; this.vel.y = 0; }
      else if (q.isWalkable(this.e, nn, RADIUS)) { this.n = nn; this.vel.x = 0; }
      else this.vel.set(0, 0);
      this.vy -= GRAVITY * dt;
      this.y += this.vy * dt;
      if (this.y < EYE) { this.y = EYE; this.vy = 0; }
    }

    // Gentle head bob while walking on foot.
    const moving = !this.fly && this.y <= EYE + 1e-3 ? Math.hypot(this.vel.x, this.vel.y) : 0;
    this.bob = (this.bob || 0) + moving * dt * 1.9;
    const bobY = Math.sin(this.bob * 2) * 0.035 * Math.min(1, moving / WALK);

    this.camera.position.set(this.e, this.y + bobY, -this.n);
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }
}
