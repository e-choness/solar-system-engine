import {
  cos,
  cross,
  dot,
  float,
  fract,
  instancedBufferAttribute,
  length,
  max,
  mix,
  modelViewMatrix,
  normalize,
  pow,
  saturate,
  sin,
  smoothstep,
  step,
  time,
  uniform,
  uv,
  varying,
  vec3,
  vec4,
} from 'three/tsl';
import * as THREE from 'three/webgpu';
import { DEG } from './astro.ts';
import { rng } from './geometry.ts';
import { type FlareSlot, SHARED } from './materials.ts';
import { disc } from './particles.ts';

type N = any; // TSL nodes are dynamically typed.

/**
 * three.js attenuates point sizes by half the canvas height over the distance, without the
 * 1 / tan(fov / 2) of a true projection. With the engine's 50° field of view, this makes sizes kilometres.
 */
const SIZE = 1 / Math.tan((50 * DEG) / 2);

/** A bright active region of the SDO/AIA map (src/data/generated/sun-active.json). */
export interface ActiveRegion {
  /** Carrington latitude and longitude (deg). */
  lat: number;
  lon: number;
  /** 0..1, brightest first. */
  strength: number;
}

/** Unit vector in the Sun's mesh frame (X = longitude 0, Y = north pole, Z = 90° W) for a Carrington position. */
export function regionDirection(lat: number, lon: number, out = new THREE.Vector3()) {
  const phi = lat * DEG;
  const lambda = lon * DEG;
  return out.set(Math.cos(phi) * Math.cos(lambda), Math.sin(phi), -Math.cos(phi) * Math.sin(lambda));
}

interface Loop {
  a: THREE.Vector3;
  b: THREE.Vector3;
  /** Apex height above the surface (km). */
  height: number;
  /** Width of the plasma tube (km). */
  thickness: number;
  /** Share of the particles. */
  weight: number;
  /** 0 = cool prominence plasma (red), 1 = hot coronal loop (gold). */
  hue: number;
  /** Loop lengths per second the plasma moves along it; the sign is the direction. */
  flow: number;
}

/**
 * Magnetic loops over every active region, their footpoints straddling it east to
 * west and tilted toward the equator (Joy's law), plus a few tall quiescent
 * prominences in the quiet Sun at higher latitudes.
 */
export function buildLoops(radius: number, regions: ActiveRegion[], seed: number): Loop[] {
  const r = rng(seed);
  const pole = new THREE.Vector3(0, 1, 0);
  const loops: Loop[] = [];
  const arch = (
    centre: THREE.Vector3,
    sepDeg: number,
    tiltDeg: number,
    height: number,
    thickness: number,
    hue: number,
    flow: number,
    density = 1,
  ) => {
    const east = new THREE.Vector3().crossVectors(pole, centre).normalize();
    const north = new THREE.Vector3().crossVectors(centre, east);
    const axis = east.multiplyScalar(Math.cos(tiltDeg * DEG)).addScaledVector(north, Math.sin(tiltDeg * DEG));
    const half = (sepDeg * DEG) / 2;
    const a = centre.clone().addScaledVector(axis, -Math.tan(half)).normalize();
    const b = centre.clone().addScaledVector(axis, Math.tan(half)).normalize();
    // Longer loops get more particles, so every loop is about equally dense.
    loops.push({ a, b, height, thickness, weight: (sepDeg + (height / radius) * 120) * density, hue, flow });
  };
  for (const reg of regions) {
    const c = regionDirection(reg.lat, reg.lon);
    const count = 3 + Math.round(reg.strength * 4);
    for (let k = 0; k < count; k++) {
      const centre = regionDirection(reg.lat + (r() - 0.5) * 4, reg.lon + (r() - 0.5) * 5, new THREE.Vector3());
      centre.lerp(c, 0.3).normalize();
      const sep = 3 + r() * 8;
      const tilt = -Math.sign(reg.lat || 1) * 8 + (r() - 0.5) * 50;
      const hot = r() < 0.65 ? 1 : 0;
      arch(
        centre,
        sep,
        tilt,
        sep * DEG * radius * (0.5 + r() * 0.5),
        radius * (0.004 + r() * 0.003),
        hot,
        (r() < 0.5 ? -1 : 1) * (0.04 + r() * 0.1),
      );
    }
  }
  for (let k = 0; k < 4; k++) {
    const lat = (r() < 0.5 ? -1 : 1) * (28 + r() * 22);
    const centre = regionDirection(lat, r() * 360);
    arch(centre, 16 + r() * 16, (r() - 0.5) * 70, radius * (0.1 + r() * 0.15), radius * 0.009, 0, (r() < 0.5 ? -1 : 1) * 0.015, 3);
  }
  return loops;
}

/**
 * Picks a loop for each particle in proportion to its weight, interleaved with the
 * golden ratio so that any prefix of the particles covers every loop evenly: drawing
 * fewer of them (lower quality) thins every loop instead of dropping some.
 */
export function assignParticles(weights: number[], count: number): Uint16Array {
  const total = weights.reduce((a, b) => a + b, 0);
  let sum = 0;
  const cumulative = weights.map((w) => (sum += w / total));
  const out = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    const x = (i * 0.6180339887498949) % 1;
    let k = 0;
    while (k < cumulative.length - 1 && cumulative[k] < x) k++;
    out[i] = k;
  }
  return out;
}

const instanced = (array: Float32Array, size: number) => new THREE.InstancedBufferAttribute(array, size);

/** Seconds an eruption's slot stays busy. */
const ERUPTION_S = 17;

/**
 * The Sun's activity, in its body frame (add `group` to the Sun's view so it turns
 * with it): plasma streaming along coronal loops and prominences, and eruptions
 * at the active regions, each a flare flash, a fountain of plasma that falls back
 * and a faster spray that escapes into space. Everything is computed on the GPU
 * from the clock, so a frame costs a handful of uniform updates.
 */
export class SolarActivity {
  readonly group = new THREE.Group();
  /** 0 hides everything (the Sun is too small on screen to show any of it). */
  private readonly fade = uniform(0);
  private readonly loops: THREE.Sprite;
  private readonly loopTotal: number;
  private readonly eruptions: Array<{ sprite: THREE.Sprite; total: number; flash: THREE.Sprite; slot: FlareSlot }> = [];
  private readonly random: () => number;
  private readonly weights: number[];
  private next = 3;

  constructor(
    private readonly radius: number,
    private readonly regions: ActiveRegion[],
    opts: { loopParticles: number; eruptionParticles: number; seed: number },
  ) {
    this.random = rng(opts.seed + 101);
    this.weights = regions.map((r) => 0.3 + r.strength);
    this.loopTotal = opts.loopParticles;
    this.loops = this.buildLoopSprite(buildLoops(radius, regions, opts.seed), opts.loopParticles, opts.seed);
    this.group.add(this.loops);
    SHARED.flares.forEach((slot, k) => {
      this.eruptions.push(this.buildEruption(slot, opts.eruptionParticles, opts.seed + 7 * k));
    });
  }

  /**
   * 1 for plasma seen against space, `onDisk` for plasma in front of the bright disk,
   * where its added glow would only wash the surface out. Evaluated per particle.
   */
  private againstSpace(local: N, onDisk: number) {
    const p = modelViewMatrix.mul(vec4(local, 1)).xyz;
    const centre = modelViewMatrix.mul(vec4(0, 0, 0, 1)).xyz;
    const ray = normalize(p);
    const miss = length(centre.sub(ray.mul(dot(centre, ray))));
    return varying(mix(float(onDisk), float(1), smoothstep(this.radius * 0.97, this.radius * 1.01, miss)));
  }

  private buildLoopSprite(loops: Loop[], count: number, seed: number) {
    const r = rng(seed + 31);
    const pick = assignParticles(
      loops.map((l) => l.weight),
      count,
    );
    const pa = new Float32Array(count * 4);
    const pb = new Float32Array(count * 4);
    const pc = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const l = loops[pick[i]];
      pa.set([l.a.x, l.a.y, l.a.z, l.height], i * 4);
      pb.set([l.b.x, l.b.y, l.b.z, l.flow], i * 4);
      pc.set([r(), r(), l.thickness, l.hue], i * 4);
    }
    const a = instancedBufferAttribute<'vec4'>(instanced(pa, 4), 'vec4');
    const b = instancedBufferAttribute<'vec4'>(instanced(pb, 4), 'vec4');
    const c = instancedBufferAttribute<'vec4'>(instanced(pc, 4), 'vec4');

    const s = fract(c.x.add(time.mul(b.w)));
    const arc = sin(s.mul(Math.PI));
    const base = normalize(mix(a.xyz, b.xyz, s));
    const jitter = vec3(fract(c.y.mul(91.7)), fract(c.y.mul(47.3)), fract(c.y.mul(13.1))).sub(0.5);
    const m = new THREE.PointsNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    m.positionNode = base.mul(arc.mul(a.w).add(this.radius)).add(jitter.mul(c.z));
    m.sizeNode = c.z.mul(SIZE * 1.8);
    const flicker = sin(time.mul(0.9).add(c.y.mul(40)))
      .mul(0.25)
      .add(0.75);
    // Footpoints glow brightest, where the loops plunge into the dense chromosphere.
    const feet = float(1).add(pow(float(1).sub(arc), 4).mul(0.8));
    const colour = mix(vec3(1.0, 0.3, 0.1), vec3(1.0, 0.68, 0.3), c.w);
    m.colorNode = colour.mul(flicker).mul(feet).mul(disc()).mul(this.againstSpace(m.positionNode, 0.3)).mul(0.55);
    m.opacityNode = disc().mul(this.fade);
    const sprite = new THREE.Sprite(m);
    sprite.count = count;
    sprite.frustumCulled = false;
    sprite.renderOrder = 3;
    return sprite;
  }

  private buildEruption(slot: FlareSlot, count: number, seed: number) {
    const r = rng(seed);
    const e = new Float32Array(count * 4).map(() => r());
    const f = new Float32Array(count * 4).map(() => r());
    const ea = instancedBufferAttribute<'vec4'>(instanced(e, 4), 'vec4');
    const fa = instancedBufferAttribute<'vec4'>(instanced(f, 4), 'vec4');
    const R = this.radius;

    // Launches are staggered over the first 1.5 s, like a real eruption building up.
    const age = SHARED.clock.sub(slot.start).sub(fa.w.mul(1.5));
    const life = mix(float(8), float(14), ea.w);
    const t = age.div(life);
    const alive = step(0, t).mul(step(t, 1));
    // A quarter of the plasma escapes (the start of a coronal mass ejection); the rest falls back.
    const escapes = step(fa.x, 0.25);
    const v = mix(float(0.03), float(0.09), ea.z)
      .mul(R)
      .mul(mix(float(1), float(1.8), escapes));
    const g = v.mul(2).div(life.mul(0.95)).mul(float(1).sub(escapes));
    const h = max(v.mul(age).sub(g.mul(age).mul(age).mul(0.5)), 0);
    const site = slot.site;
    const t1 = normalize(cross(vec3(0, 1, 0), site));
    const t2 = cross(site, t1);
    const angle = ea.y.mul(Math.PI * 2);
    const spread = mix(float(0.01), float(0.12), ea.x).add(h.div(R).mul(0.4));
    const dir = normalize(
      site.add(
        t1
          .mul(cos(angle))
          .add(t2.mul(sin(angle)))
          .mul(spread),
      ),
    );

    const m = new THREE.PointsNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    m.positionNode = dir.mul(h.add(R));
    m.sizeNode = mix(float(0.006 * SIZE), float(0.018 * SIZE), fa.y)
      .mul(R)
      .mul(saturate(t).mul(1.5).add(1));
    // White-hot at launch, cooling to the deep red of prominence plasma.
    const colour = mix(vec3(1.0, 0.92, 0.75).mul(1.6), vec3(1.0, 0.3, 0.09).mul(0.8), smoothstep(0, 0.25, t));
    // Falling plasma fades as it drains back into the chromosphere.
    const landing = mix(smoothstep(0, R * 0.004, h), float(1), escapes);
    const visible = smoothstep(0, 0.02, t)
      .mul(float(1).sub(smoothstep(0.7, 1, t)))
      .mul(alive)
      .mul(landing)
      .mul(slot.strength.mul(0.5).add(0.5));
    m.colorNode = colour.mul(disc()).mul(this.againstSpace(m.positionNode, 0.4));
    m.opacityNode = disc().mul(visible).mul(this.fade);
    const sprite = new THREE.Sprite(m);
    sprite.count = count;
    sprite.frustumCulled = false;
    sprite.renderOrder = 3;

    const fm = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const d = length(uv().sub(0.5)).mul(2);
    fm.colorNode = vec3(1.0, 0.9, 0.75).mul(
      pow(saturate(float(1).sub(d)), 3)
        .mul(slot.flash)
        .mul(2.5)
        .mul(this.fade),
    );
    const flash = new THREE.Sprite(fm);
    flash.scale.setScalar(R * 0.25);
    flash.renderOrder = 3;
    flash.visible = false;
    this.group.add(sprite, flash);
    return { sprite, total: count, flash, slot };
  }

  /** Fraction of the particles drawn (quality setting). */
  setDensity(fraction: number) {
    const f = Math.min(1, Math.max(0.1, fraction));
    this.loops.count = Math.max(1, Math.floor(this.loopTotal * f));
    for (const e of this.eruptions) e.sprite.count = Math.max(1, Math.floor(e.total * f));
  }

  /** Starts an eruption now at an active region, if a slot is free; returns the region erupting. */
  erupt(clock: number, index?: number): ActiveRegion | null {
    const free = this.eruptions.find((e) => clock - e.slot.start.value > ERUPTION_S);
    if (!free || this.regions.length === 0) return null;
    let k = index ?? 0;
    if (index === undefined) {
      let x = this.random() * this.weights.reduce((a, b) => a + b, 0);
      while (k < this.weights.length - 1 && x > this.weights[k]) x -= this.weights[k++];
    }
    const reg = this.regions[k];
    const site = regionDirection(reg.lat + (this.random() - 0.5) * 3, reg.lon + (this.random() - 0.5) * 3, free.slot.site.value);
    free.slot.start.value = clock;
    free.slot.strength.value = reg.strength;
    free.flash.position.copy(site).multiplyScalar(this.radius * 1.004);
    return reg;
  }

  /**
   * @param clock engine seconds
   * @param sunPx apparent radius of the Sun on screen (px)
   */
  update(clock: number, sunPx: number) {
    SHARED.clock.value = clock;
    const fade = THREE.MathUtils.smoothstep(sunPx, 25, 90);
    this.fade.value = fade;
    this.group.visible = fade > 0;
    if (clock >= this.next) {
      this.erupt(clock);
      this.next = clock + 5 + this.random() * 12;
    }
    for (const e of this.eruptions) {
      const age = clock - e.slot.start.value;
      const flash =
        age < 0 || age > ERUPTION_S
          ? 0
          : THREE.MathUtils.smoothstep(age, 0, 0.5) * Math.exp(-age / 2.2) * (0.6 + 0.4 * e.slot.strength.value);
      e.slot.flash.value = flash * fade;
      e.flash.visible = flash > 0.002 && fade > 0;
      // An idle slot draws nothing: its particles would all be dead, but still cost their quads.
      e.sprite.visible = fade > 0 && age >= 0 && age <= ERUPTION_S;
    }
  }
}
