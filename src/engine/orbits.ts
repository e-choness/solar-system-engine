import { attribute, float, fract, mix, pow, uniform } from 'three/tsl';
import * as THREE from 'three/webgpu';
import type { BodyKind } from '../data/types.ts';
import { DEG, eccentricAnomaly, type Snapshot, sampleOrbit, type Vec3 } from './astro.ts';
import type { BodyState } from './system.ts';

export const ORBIT_COLORS: Record<BodyKind, string> = {
  star: '#ffffff',
  planet: '#6aa8ff',
  dwarf: '#b893ff',
  moon: '#7fd8c4',
  asteroid: '#d4a96a',
  comet: '#8fd3ff',
};

const SEGMENTS = 720;
const BIAS_HIGH_E = 1.8;

/** Orbit-ellipse parameter (0..1) of the body's current position, matching sampleOrbit(). */
function bodyParam(s: Snapshot): number {
  const E = eccentricAnomaly(s.M * DEG, s.e);
  const bias = s.e > 0.5 ? BIAS_HIGH_E : 1;
  const t = Math.sign(E) * (Math.abs(E) / Math.PI) ** (1 / bias);
  return (t + 1) / 2;
}

class OrbitLine {
  readonly line: THREE.Line;
  readonly body: BodyState;
  private readonly positions: Float32Array;
  private last: Snapshot | null = null;
  readonly uParam = uniform(0);
  readonly uAlpha = uniform(1);
  readonly uColor = uniform(new THREE.Color());

  constructor(body: BodyState) {
    this.body = body;
    const geo = new THREE.BufferGeometry();
    this.positions = new Float32Array((SEGMENTS + 1) * 3);
    const param = new Float32Array(SEGMENTS + 1).map((_, k) => k / SEGMENTS);
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('param', new THREE.BufferAttribute(param, 1));
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

  /** Re-samples the ellipse when precession has moved it noticeably. */
  refresh(s: Snapshot) {
    const l = this.last;
    if (
      l &&
      Math.abs(l.a - s.a) / s.a < 1e-4 &&
      Math.abs(l.e - s.e) < 1e-4 &&
      Math.abs(l.i - s.i) < 0.02 &&
      Math.abs(l.node - s.node) < 0.05 &&
      Math.abs(l.peri - s.peri) < 0.05
    ) {
      return;
    }
    this.last = { ...s };
    const pts = sampleOrbit(s, SEGMENTS);
    for (let k = 0; k <= SEGMENTS; k++) {
      // ecliptic → scene
      this.positions[k * 3] = pts[k * 3];
      this.positions[k * 3 + 1] = pts[k * 3 + 2];
      this.positions[k * 3 + 2] = -pts[k * 3 + 1];
    }
    const attr = this.line.geometry.attributes.position as THREE.BufferAttribute;
    attr.needsUpdate = true;
    this.line.geometry.computeBoundingSphere();
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
      const dx = c[0] - view.cam[0];
      const dy = c[1] - view.cam[1];
      const dz = c[2] - view.cam[2];
      const dist = Math.hypot(dx, dy, dz);
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
      o.refresh(s);
      o.uAlpha.value = alpha;
      o.uParam.value = bodyParam(s);
      o.uColor.value.set(selected ? '#ffffff' : ORBIT_COLORS[b.def.kind]);
      o.line.position.set(dx, dz, -dy);
    }
  }
}
