import * as THREE from 'three/webgpu';
import type { Vec3 } from './astro.ts';
import type { BodyState } from './system.ts';

const UP = new THREE.Vector3(0, 1, 0);
const tmpM = new THREE.Matrix4();
const ORIGIN = new THREE.Vector3();

/** Scene-frame offset (Y-up) → ecliptic offset. */
const sceneToEcl = (v: THREE.Vector3): Vec3 => [v.x, -v.z, v.y];
const eclToSceneV = (p: Vec3, out = new THREE.Vector3()) => out.set(p[0], p[2], -p[1]);

const smoother = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

interface Flight {
  from: BodyState;
  to: BodyState;
  t: number;
  duration: number;
  dir0: THREE.Vector3;
  dir1: THREE.Vector3;
  d0: number;
  d1: number;
}

export interface FlyOptions {
  /** Final distance from the body centre (km). */
  distance?: number;
  /** Final view direction from the body (scene frame, unit). */
  direction?: THREE.Vector3;
  duration?: number;
}

/**
 * Orbit-style camera around a focused body, expressed in float64 heliocentric
 * coordinates. The three.js camera itself stays at the origin (floating origin).
 */
export class CameraRig {
  focus: BodyState;
  distance: number;
  yaw = 0.6;
  pitch = 0.35;
  minDistance = 1;
  readonly maxDistance = 3e13;
  /** Camera position in heliocentric ecliptic km. */
  readonly position: Vec3 = [0, 0, 0];
  /** Point being looked at (heliocentric ecliptic km). */
  readonly look: Vec3 = [0, 0, 0];
  private vYaw = 0;
  private vPitch = 0;
  private vZoom = 0;
  private flight: Flight | null = null;
  onArrive?: (body: BodyState) => void;

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    focus: BodyState,
    distance: number,
  ) {
    this.focus = focus;
    this.distance = distance;
  }

  get flying() {
    return this.flight !== null;
  }

  rotate(dx: number, dy: number) {
    if (this.flight) return;
    this.vYaw -= dx;
    this.vPitch += dy;
  }

  zoom(delta: number) {
    if (this.flight) return;
    this.vZoom += delta;
  }

  /** Instantly re-targets without a flight (e.g. at startup). */
  jumpTo(body: BodyState, distance: number) {
    this.flight = null;
    this.focus = body;
    this.distance = distance;
  }

  flyTo(body: BodyState, opts: FlyOptions = {}) {
    const target = eclToSceneV(body.pos);
    const cam = eclToSceneV(this.position);
    const off = cam.clone().sub(target);
    const d0 = Math.max(off.length(), 1e-3);
    const dir0 = off.normalize();
    const d1 = opts.distance ?? this.distance;
    const dir1 = (opts.direction ?? dir0).clone().normalize();
    const ratio = Math.abs(Math.log10(d0 / d1));
    this.vYaw = this.vPitch = this.vZoom = 0;
    this.flight = {
      from: this.focus,
      to: body,
      t: 0,
      duration: opts.duration ?? Math.min(7, 1.6 + ratio * 0.55),
      dir0,
      dir1,
      d0,
      d1,
    };
    return this.flight.duration;
  }

  update(dt: number) {
    const f = this.flight;
    if (f) {
      f.t = Math.min(1, f.t + dt / f.duration);
      const s = smoother(f.t);
      const target = eclToSceneV(f.to.pos);
      const from = eclToSceneV(f.from.pos);
      const dir = f.dir0.clone().lerp(f.dir1, s);
      if (dir.lengthSq() < 1e-8) dir.copy(f.dir1);
      dir.normalize();
      const d = Math.exp(Math.log(f.d0) + (Math.log(f.d1) - Math.log(f.d0)) * s);
      const cam = target.clone().addScaledVector(dir, d);
      const lookT = smoother(Math.min(1, f.t / 0.38));
      const look = from.lerp(target, lookT);
      this.setPose(cam, look);
      if (f.t >= 1) {
        this.flight = null;
        this.focus = f.to;
        this.distance = f.d1;
        this.yaw = Math.atan2(dir.x, dir.z);
        this.pitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
        this.onArrive?.(f.to);
      }
      return;
    }

    const damp = Math.exp(-dt * 6);
    this.yaw += this.vYaw * (1 - damp);
    this.pitch += this.vPitch * (1 - damp);
    this.distance *= Math.exp(this.vZoom * (1 - damp));
    this.vYaw *= damp;
    this.vPitch *= damp;
    this.vZoom *= damp;
    this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch));
    this.distance = Math.max(this.minDistance, Math.min(this.maxDistance, this.distance));

    const target = eclToSceneV(this.focus.pos);
    const dir = new THREE.Vector3(
      Math.cos(this.pitch) * Math.sin(this.yaw),
      Math.sin(this.pitch),
      Math.cos(this.pitch) * Math.cos(this.yaw),
    );
    this.setPose(target.clone().addScaledVector(dir, this.distance), target);
  }

  private setPose(cam: THREE.Vector3, look: THREE.Vector3) {
    const p = sceneToEcl(cam);
    const l = sceneToEcl(look);
    for (let k = 0; k < 3; k++) {
      this.position[k] = p[k];
      this.look[k] = l[k];
    }
    // Orientation only: the camera stays at the origin.
    const rel = look.clone().sub(cam);
    const up = Math.abs(rel.clone().normalize().dot(UP)) > 0.999 ? new THREE.Vector3(0, 0, -1) : UP;
    tmpM.lookAt(ORIGIN, rel, up);
    this.camera.quaternion.setFromRotationMatrix(tmpM);
    this.camera.position.set(0, 0, 0);
  }
}
