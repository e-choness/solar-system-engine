import { attribute, float, fract, mix, pow, uniform } from 'three/tsl';
import * as THREE from 'three/webgpu';
import type { BodyKind } from '../data/types.ts';
import { DEG, eccentricAnomaly, ellipsePoint, orbitAnomalies, orbitRotation, type Snapshot, type Vec3, wrapPi } from './astro.ts';
import type { BodyState } from './system.ts';

export const ORBIT_COLORS: Record<BodyKind, string> = {
  star: '#ffffff',
  planet: '#6aa8ff',
  dwarf: '#b893ff',
  moon: '#7fd8c4',
  asteroid: '#d4a96a',
  comet: '#8fd3ff',
};

/** Evenly spread vertices around the whole ellipse. */
const BASE_SEGMENTS = 512;
/** Extra vertices packed around the body (cubic spacing, finest at the body). */
const LOCAL_SEGMENTS = 256;
/** Half-width of the packed window, in eccentric anomaly. */
const WINDOW = Math.PI / 6;
const MAX_VERTICES = BASE_SEGMENTS + LOCAL_SEGMENTS + 2;
const TAU = Math.PI * 2;
/** Allowed gap between a body and its drawn orbit, in screen pixels. */
const TOLERANCE_PX = 0.25;

const angleDiff = (a: number, b: number) => Math.abs(wrapPi((a - b) * DEG)) / DEG;

/**
 * One orbit polyline. Vertices are stored relative to the body's position at
 * sampling time (in float64, then float32), so the line is precise where the
 * camera usually is — next to the body — even for orbits billions of km wide.
 */
class OrbitLine {
  readonly line: THREE.Line;
  readonly body: BodyState;
  private readonly positions = new Float32Array(MAX_VERTICES * 3);
  private readonly params = new Float32Array(MAX_VERTICES);
  private readonly offsets = new Float64Array(MAX_VERTICES);
  /** Snapshot and anomaly the vertices were sampled for. */
  private last: Snapshot | null = null;
  private E0 = 0;
  private scale = 1;
  /** Body position relative to the orbit centre at E0 (km, before scaling). */
  readonly anchor: Vec3 = [0, 0, 0];
  readonly uParam = uniform(0);
  readonly uAlpha = uniform(1);
  readonly uColor = uniform(new THREE.Color());

  constructor(body: BodyState) {
    this.body = body;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('param', new THREE.BufferAttribute(this.params, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    const material = new THREE.LineBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    // Bright just behind the body, fading around the ellipse like a trail.
    const behind = fract(this.uParam.sub(attribute('param', 'float')));
    const trail = mix(float(0.14), float(1), pow(float(1).sub(behind), 1.6));
    material.colorNode = this.uColor.mul(trail).mul(this.uAlpha);
    this.line = new THREE.Line(geo, material);
    this.line.frustumCulled = false;
    this.line.renderOrder = -1;
    this.uColor.value.set(ORBIT_COLORS[body.def.kind]);
  }

  /** True when the drawn line would sit more than `tol` km from the body's true path. */
  private stale(s: Snapshot, E: number, scale: number, tol: number) {
    const l = this.last;
    if (!l || scale !== this.scale) return true;
    // How far the ellipse itself has moved (secular precession of the elements).
    const shift =
      Math.abs(l.a - s.a) +
      2 * s.a * Math.abs(l.e - s.e) +
      s.a *
        DEG *
        (Math.abs(l.i - s.i) + (Math.abs(Math.sin(s.i * DEG)) + 2 * s.e) * angleDiff(l.node, s.node) + 2 * s.e * angleDiff(l.peri, s.peri));
    // How coarse the polyline is where the body has drifted to, plus float32 error of the offsets.
    const drift = Math.abs(wrapPi(E - this.E0));
    if (drift >= WINDOW) return true;
    const t = Math.cbrt(drift / WINDOW);
    const step = (3 * WINDOW * t * t) / (LOCAL_SEGMENTS / 2);
    const chord = (s.a * step * step) / 8;
    const precision = s.a * drift * 2.4e-7;
    return (shift + chord + precision) * scale > tol;
  }

  /** Re-samples the ellipse around the body when it has drifted or precessed past the tolerance. */
  refresh(s: Snapshot, E: number, scale: number, tol: number) {
    if (!this.stale(s, E, scale, tol)) return;
    this.last = { ...s };
    this.E0 = E;
    this.scale = scale;
    const rot = orbitRotation(s);
    const a = ellipsePoint(s, rot, E);
    for (let k = 0; k < 3; k++) this.anchor[k] = a[k];
    const n = orbitAnomalies(s.e, E, BASE_SEGMENTS, LOCAL_SEGMENTS, WINDOW, this.offsets);
    for (let k = 0; k < n; k++) {
      const d = this.offsets[k];
      const p = ellipsePoint(s, rot, E + d);
      // ecliptic → scene, relative to the anchor
      this.positions[k * 3] = (p[0] - a[0]) * scale;
      this.positions[k * 3 + 1] = (p[2] - a[2]) * scale;
      this.positions[k * 3 + 2] = -(p[1] - a[1]) * scale;
      this.params[k] = d / TAU;
    }
    const geo = this.line.geometry;
    geo.setDrawRange(0, n);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.param.needsUpdate = true;
  }

  /** Trail head: the body's drift since sampling, as a fraction of the orbit. */
  setHead(E: number) {
    this.uParam.value = wrapPi(E - this.E0) / TAU;
  }
}

/** Unselected orbit brightness by kind: planets lead, small bodies stay in the background. */
const ORBIT_WEIGHT: Record<BodyKind, number> = { star: 0, planet: 0.6, dwarf: 0.42, moon: 0.5, asteroid: 0.26, comet: 0.3 };

export interface OrbitView {
  cam: Vec3;
  pixelsPerRadian: number;
  selectedId: string | null;
  focusId: string | null;
  /** On-screen radius of the focused body (px). */
  focusPx: number;
  showMoons: boolean;
  opacity: number;
}

/** True when `b` belongs to the focused body's local system (itself, its moons, its parent and siblings). */
function related(b: BodyState, focusId: string | null, focusParent: BodyState | null) {
  if (b.def.id === focusId || b.parent?.def.id === focusId) return true;
  return Boolean(focusParent && focusParent.def.kind !== 'star' && (b === focusParent || b.parent === focusParent));
}

export class Orbits {
  readonly group = new THREE.Group();
  private readonly lines: OrbitLine[];

  constructor(bodies: BodyState[]) {
    this.lines = bodies.filter((b) => b.parent).map((b) => new OrbitLine(b));
    for (const l of this.lines) this.group.add(l.line);
  }

  update(view: OrbitView) {
    const focusParent = this.lines.find((o) => o.body.def.id === view.focusId)?.body.parent ?? null;
    // Close to a world, orbits of unrelated bodies only slice across the view.
    const closeUp = Math.min(1, Math.max(0, (view.focusPx - 20) / 120));
    for (const o of this.lines) {
      const b = o.body;
      const s = b.snapshot;
      if (!s) {
        o.line.visible = false;
        continue;
      }
      const c = b.orbitCenter();
      const dist = Math.hypot(c[0] - view.cam[0], c[1] - view.cam[1], c[2] - view.cam[2]);
      // Hide orbits that are too small on screen to be useful, or absurdly large.
      const px = (s.a / Math.max(dist, 1)) * view.pixelsPerRadian;
      const selected = b.def.id === view.selectedId || b.def.id === view.focusId;
      let alpha = Math.min(1, Math.max(0, (px - 14) / 50));
      // Orbits many screens wide only show up as straight lines slicing the sky.
      if (!selected) alpha *= 1 - THREE.MathUtils.smoothstep(px, 4000, 16000);
      if (b.def.kind === 'moon' && !view.showMoons && !selected) alpha *= 0.35;
      // Very close to the body itself the line slices through the scene: fade it.
      const bodyDist = Math.hypot(b.pos[0] - view.cam[0], b.pos[1] - view.cam[1], b.pos[2] - view.cam[2]);
      alpha *= Math.min(1, Math.max(0.08, (bodyDist / (b.radius * 60)) ** 0.5));
      alpha *= view.opacity * (selected ? 1 : ORBIT_WEIGHT[b.def.kind]);
      if (!selected && !related(b, view.focusId, focusParent)) alpha *= 1 - 0.92 * closeUp;
      o.line.visible = alpha > 0.01;
      if (!o.line.visible) continue;

      // A large moon and its primary both circle their barycentre: the moon's
      // path is its relative orbit shrunk by (1 − share), and the primary's
      // path is the barycentre's orbit shifted by its current wobble.
      const primary = b.parent?.partner === b ? b.parent : null;
      const scale = primary ? 1 - (primary.def.baryShare ?? 0) : 1;
      const E = eccentricAnomaly(s.M * DEG, s.e);
      o.refresh(s, E, scale, (Math.max(bodyDist, b.radius) / view.pixelsPerRadian) * TOLERANCE_PX);
      o.setHead(E);
      o.uAlpha.value = alpha;
      o.uColor.value.set(selected ? '#ffffff' : ORBIT_COLORS[b.def.kind]);
      const wobble = b.partner ? [b.pos[0] - b.bary[0], b.pos[1] - b.bary[1], b.pos[2] - b.bary[2]] : [0, 0, 0];
      const x = c[0] + o.anchor[0] * scale + wobble[0] - view.cam[0];
      const y = c[1] + o.anchor[1] * scale + wobble[1] - view.cam[1];
      const z = c[2] + o.anchor[2] * scale + wobble[2] - view.cam[2];
      o.line.position.set(x, z, -y);
    }
  }
}
