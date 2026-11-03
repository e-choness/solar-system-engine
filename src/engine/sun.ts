import {
  abs,
  atan,
  cos,
  cross,
  dot,
  exp,
  float,
  floor,
  fract,
  hash,
  instancedBufferAttribute,
  length,
  max,
  mix,
  modelViewMatrix,
  normalize,
  pow,
  saturate,
  sign,
  sin,
  smoothstep,
  sqrt,
  step,
  time,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import * as THREE from 'three/webgpu';
import { DEG } from './astro.ts';
import { rng } from './geometry.ts';
import { type FlareSlot, SHARED } from './materials.ts';

type N = any; // TSL nodes are dynamically typed.

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

// ───────────────────────────────────────────────────────────── flow field

/** Two fixed rotations, so the flow's octaves line up neither with each other nor with the axes. */
const TURNS = [new THREE.Euler(0.7, 1.9, 0.3), new THREE.Euler(2.4, 0.5, 1.3)].map((e) => {
  const m = new THREE.Matrix4().makeRotationFromEuler(e).elements;
  return [vec3(m[0], m[4], m[8]), vec3(m[1], m[5], m[9]), vec3(m[2], m[6], m[10])];
});
const turn = (k: number, p: N) => vec3(dot(TURNS[k][0], p), dot(TURNS[k][1], p), dot(TURNS[k][2], p));

/** Arnold–Beltrami–Childress flow (A = B = C = 1): divergence-free, with chaotic, swirling streamlines. */
const abc = (q: N) => vec3(sin(q.z).add(cos(q.y)), sin(q.x).add(cos(q.z)), sin(q.y).add(cos(q.x)));

/**
 * A smooth, divergence-free swirl field of about unit strength: two octaves of ABC
 * flow drifting with `t`. Moving particles along it bends their paths into eddies
 * and threads without bunching them up, like curl noise but only a few sines a call.
 */
export function swirl(p: N, t: N): N {
  const a = abc(turn(0, p).add(vec3(t, t.mul(-0.7), t.mul(0.4))));
  const b = abc(
    turn(1, p)
      .mul(2.3)
      .add(vec3(t.mul(-0.6), t.mul(0.9), t.mul(0.5))),
  );
  return a.add(b.mul(0.5)).mul(1 / 3);
}

// ───────────────────────────────────────────────────────────── loops

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

const attribute = (array: Float32Array) => instancedBufferAttribute<'vec4'>(new THREE.InstancedBufferAttribute(array, 4), 'vec4');

/** `count` vec4s of uniform random numbers, as an instanced attribute. */
const randoms = (count: number, r: () => number) => attribute(new Float32Array(count * 4).map(() => r()));

/** Seconds an eruption's slot stays busy. */
const ERUPTION_S = 17;

/** One eruption slot: the shared flare state plus the geometry of this eruption. */
interface Eruption {
  slot: FlareSlot;
  /** Unit tangent along which the erupting filament lies (footpoint to footpoint). */
  axis: N;
  /** Size of the eruption, about 1. */
  size: N;
  /** Integer seed, so each eruption's jets point their own way. */
  seed: N;
  /** Rising flux rope, jets, then the post-flare arcade. */
  parts: Array<{ sprite: THREE.Sprite; total: number }>;
  flash: THREE.Sprite;
}

/**
 * The Sun's activity, in its body frame (add `group` to the Sun's view so it turns
 * with it): plasma threading coronal loops and prominences, a haze of fine threads
 * over the whole surface, and eruptions at the active regions.
 *
 * Every particle is a short streak from where it was a moment ago to where it is
 * now, carried along a divergence-free swirl field, and drawn about a pixel wide.
 * Thousands of dim, correlated streaks then read as threads and eddies instead of
 * a spray of dots. Everything is computed on the GPU from the clock, so a frame
 * costs a handful of uniform updates.
 */
export class SolarActivity {
  readonly group = new THREE.Group();
  /** 0 hides everything (the Sun is too small on screen to show any of it). */
  private readonly fade = uniform(0);
  /** Angular size of a CSS pixel (rad): streaks are never drawn thinner than about one. */
  private readonly pxAngle = uniform(0.001);
  private readonly loops: THREE.Sprite;
  private readonly loopTotal: number;
  private readonly threads: THREE.Sprite;
  private readonly threadTotal: number;
  private readonly eruptions: Eruption[] = [];
  private readonly random: () => number;
  private readonly weights: number[];
  private next = 3;

  constructor(
    private readonly radius: number,
    private readonly regions: ActiveRegion[],
    opts: { loopParticles: number; threadParticles: number; eruptionParticles: number; seed: number },
  ) {
    this.random = rng(opts.seed + 101);
    this.weights = regions.map((r) => 0.3 + r.strength);
    this.loopTotal = opts.loopParticles;
    this.threadTotal = opts.threadParticles;
    this.loops = this.buildLoops(buildLoops(radius, regions, opts.seed), opts.loopParticles, opts.seed);
    this.threads = this.buildThreads(opts.threadParticles, opts.seed);
    this.group.add(this.threads, this.loops);
    SHARED.flares.forEach((slot, k) => {
      this.eruptions.push(this.buildEruption(slot, opts.eruptionParticles, opts.seed + 7 * k));
    });
  }

  /**
   * 1 for plasma seen against space, `onDisk` for plasma in front of the bright disk,
   * where its added glow would only wash the surface out.
   */
  private againstSpace(local: N, onDisk: number) {
    const p = modelViewMatrix.mul(vec4(local, 1)).xyz;
    const centre = modelViewMatrix.mul(vec4(0, 0, 0, 1)).xyz;
    const ray = normalize(p);
    const miss = length(centre.sub(ray.mul(dot(centre, ray))));
    return mix(float(onDisk), float(1), smoothstep(this.radius * 0.97, this.radius * 1.01, miss));
  }

  /**
   * A particle drawn as a streak from `tail` to `head` (local km): a capsule that
   * brightens toward the head, so fast plasma leaves a trail and plasma sliding along
   * a field line draws a thread. It is never thinner than about a pixel; a strand
   * widened to that is dimmed to match, so distant threads fade instead of sparkling.
   * With `onDisk` 0, streaks over the disk are collapsed to nothing rather than drawn black.
   */
  private streak(head: N, tail: N, width: N, colour: N, onDisk: number, count: number) {
    const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const hv = modelViewMatrix.mul(vec4(head, 1)).xyz;
    const tv = modelViewMatrix.mul(vec4(tail, 1)).xyz;
    const d = hv.xy.sub(tv.xy);
    const len = length(d);
    const w = max(width, hv.z.negate().mul(this.pxAngle).mul(1.4));
    const space = this.againstSpace(head, onDisk);
    m.positionNode = head.add(tail).mul(0.5);
    m.rotationNode = atan(d.y, d.x);
    m.scaleNode = vec2(len.add(w), w).mul(onDisk > 0 ? 1 : step(0.001, space));
    // Streak length in widths; uv.x runs from the tail to the head.
    const lw = len.div(w);
    const L = varying(lw);
    const X = uv().x.sub(0.5).mul(L.add(1));
    const Y = uv().y.sub(0.5);
    const dx = max(abs(X).sub(L.mul(0.5)), 0);
    const core = exp(dx.mul(dx).add(Y.mul(Y)).mul(-16))
      .sub(Math.exp(-4))
      .max(0);
    const t = saturate(X.div(max(L, 1)).add(0.5));
    const trail = mix(float(1), t.mul(t).mul(0.85).add(0.15), saturate(L));
    const gain: N = varying(
      colour
        .mul(width.div(w))
        .mul(pow(lw.add(1), -0.3))
        .mul(space),
    );
    m.colorNode = gain.mul(core.mul(trail));
    m.opacityNode = this.fade;
    const sprite = new THREE.Sprite(m);
    sprite.count = count;
    sprite.frustumCulled = false;
    sprite.renderOrder = 3;
    return sprite;
  }

  /**
   * Each loop is a bundle of twisted strands. Hot loops carry a siphon flow from one
   * footpoint to the other; cool prominence loops rain plasma from the apex down both
   * legs, speeding up as it falls.
   */
  private buildLoops(loops: Loop[], count: number, seed: number) {
    const r = rng(seed + 31);
    const pick = assignParticles(
      loops.map((l) => l.weight),
      count,
    );
    const strands = loops.map(() =>
      Array.from({ length: 5 + Math.floor(r() * 5) }, () => {
        const ang = r() * Math.PI * 2;
        const rad = Math.sqrt(r());
        return [Math.cos(ang) * rad, Math.sin(ang) * rad, 0.35 + r() ** 2 * 1.3];
      }),
    );
    const twist = loops.map(() => (r() - 0.5) * 1.6);
    const pa = new Float32Array(count * 4);
    const pb = new Float32Array(count * 4);
    const pc = new Float32Array(count * 4);
    const pd = new Float32Array(count * 4);
    const pe = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const k = pick[i];
      const l = loops[k];
      const [ox, oy, bright] = strands[k][Math.floor(r() * strands[k].length)];
      const rain = l.hue === 0;
      const [s0, s1] = rain ? [0.5, r() < 0.5 ? 0 : 1] : l.flow > 0 ? [0, 1] : [1, 0];
      pa.set([l.a.x, l.a.y, l.a.z, l.height], i * 4);
      pb.set([l.b.x, l.b.y, l.b.z, l.thickness], i * 4);
      pc.set([r(), Math.abs(l.flow) * (rain ? 3 : 1), s0, s1], i * 4);
      pd.set([ox + (r() - 0.5) * 0.15, oy + (r() - 0.5) * 0.15, bright, l.hue], i * 4);
      pe.set([twist[k], rain ? 1 : 0, (k * 7.31) % 50, 0], i * 4);
    }
    const a = attribute(pa);
    const b = attribute(pb);
    const c = attribute(pc);
    const dd = attribute(pd);
    const e = attribute(pe);
    const R = this.radius;
    const plane = normalize(cross(a.xyz, b.xyz));
    // Position along the loop (0 at the start of this particle's flow, 1 at its end).
    const along = (u: N) => mix(c.z, c.w, mix(u, u.mul(u), e.y));
    const point = (u: N) => {
      const s = along(u);
      const base = normalize(mix(a.xyz, b.xyz, s));
      const arc = sin(s.mul(Math.PI));
      const ang = s.mul(e.x).mul(Math.PI * 2);
      const ca = cos(ang);
      const sa = sin(ang);
      // Flux tubes widen with height; the strands twist around the loop's axis.
      const off = base
        .mul(dd.x.mul(ca).sub(dd.y.mul(sa)))
        .add(plane.mul(dd.x.mul(sa).add(dd.y.mul(ca))))
        .mul(b.w.mul(arc.mul(0.7).add(0.3)));
      // Field lines wander slowly, most at the top, least at the anchored feet.
      const wander = swirl(base.mul(2.5).add(e.z), time.mul(0.05)).mul(a.w.mul(0.15).mul(arc));
      return base.mul(arc.mul(a.w).add(R)).add(off).add(wander);
    };
    const u = fract(c.x.add(time.mul(c.y)));
    const arc = sin(along(u).mul(Math.PI));
    // Footpoints glow brightest, where the loops plunge into the dense chromosphere.
    const feet = float(1).add(pow(float(1).sub(arc), 4).mul(0.8));
    const life = smoothstep(0, 0.08, u).mul(float(1).sub(smoothstep(0.88, 1, u)));
    const flicker = sin(time.mul(0.9).add(c.x.mul(40)))
      .mul(0.2)
      .add(0.8);
    const colour = mix(vec3(1.0, 0.3, 0.1), vec3(1.0, 0.6, 0.24), dd.w)
      .mul(dd.z.mul(feet).mul(life).mul(flicker))
      .mul(0.9);
    return this.streak(point(u), point(max(u.sub(0.07), 0)), b.w.mul(0.3), colour, 0.3, count);
  }

  /**
   * A haze of fine threads over the whole Sun, densest over the active regions:
   * plasma combed along the surface by the swirl field and drifting outward at the
   * poles. Seen edge-on at the limb it piles up into a fuzzy, fibrous rim; over the
   * disk it would be lost in the glare, so it is not drawn there at all.
   */
  private buildThreads(count: number, seed: number) {
    const r = rng(seed + 53);
    const g = new Float32Array(count * 4);
    const h = new Float32Array(count * 4);
    const v = new THREE.Vector3();
    const total = this.weights.reduce((a, b) => a + b, 0);
    const gauss = () => r() + r() + r() - 1.5;
    for (let i = 0; i < count; i++) {
      if (this.regions.length && r() < 0.45) {
        let x = r() * total;
        let k = 0;
        while (k < this.weights.length - 1 && x > this.weights[k]) x -= this.weights[k++];
        const reg = this.regions[k];
        regionDirection(reg.lat + gauss() * 9, reg.lon + (gauss() * 9) / Math.cos(reg.lat * DEG), v);
      } else {
        const z = r() * 2 - 1;
        const phi = r() * Math.PI * 2;
        v.set(Math.sqrt(1 - z * z) * Math.cos(phi), z, Math.sqrt(1 - z * z) * Math.sin(phi));
      }
      g.set([v.x, v.y, v.z, r()], i * 4);
      h.set([r(), 2.5 + r() * 3, 0.3 + r() ** 2 * 1.2, Math.floor(r() * 1000)], i * 4);
    }
    const ga = attribute(g);
    const ha = attribute(h);
    const R = this.radius;
    const cycle = time.div(ha.y).add(ha.x);
    const age = fract(cycle);
    // Each life starts a little elsewhere, so the haze never repeats itself.
    const n = floor(cycle).mul(7919).add(ha.w.mul(97));
    const jitter = vec3(hash(n), hash(n.add(1)), hash(n.add(2))).sub(0.5);
    const d0 = normalize(ga.xyz.add(jitter.mul(0.12)));
    const lift = ga.w.mul(ga.w).mul(ga.w);
    const polar = smoothstep(0.7, 0.95, abs(d0.y));
    // The swirl field at the thread's start, flattened onto the surface. One sample
    // serves the whole life: a thread is short, and the respawn jitter varies the paths.
    const s = swirl(d0.mul(3), time.mul(0.02));
    const flow = s.sub(d0.mul(dot(s, d0)));
    const at = (a: N) => {
      const dir = normalize(d0.add(flow.mul(a.mul(0.1))));
      return dir.mul(
        lift
          .mul(0.1)
          .add(1.002)
          .add(a.mul(polar.mul(3).add(1)).mul(0.012))
          .mul(R),
      );
    };
    const life = pow(sin(age.mul(Math.PI)), 1.5);
    const colour = mix(vec3(1.0, 0.36, 0.12), vec3(1.0, 0.7, 0.4), ga.w)
      .mul(ha.z.mul(life).mul(exp(lift.mul(-2))))
      .mul(1.8);
    return this.streak(at(age), at(max(age.sub(0.2), 0)), float(R * 0.0016), colour, 0, count);
  }

  private buildEruption(slot: FlareSlot, count: number, seed: number): Eruption {
    const R = this.radius;
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
    const er: Eruption = { slot, axis: uniform(new THREE.Vector3(0, 0, 1)), size: uniform(1), seed: uniform(0), parts: [], flash };
    const r = rng(seed);
    const rope = Math.round(count * 0.5);
    const jets = Math.round(count * 0.25);
    const arcade = count - rope - jets;
    er.parts.push(
      { sprite: this.buildRope(er, rope, r), total: rope },
      { sprite: this.buildJets(er, jets, r), total: jets },
      { sprite: this.buildArcade(er, arcade, r), total: arcade },
    );
    for (const p of er.parts) this.group.add(p.sprite);
    this.group.add(flash);
    return er;
  }

  /**
   * The erupting filament: a twisted flux rope anchored at both ends whose middle
   * lifts off, accelerates and balloons outward (the start of a coronal mass
   * ejection), kinking as it rises while its threads stream both ways along it.
   */
  private buildRope(er: Eruption, count: number, r: () => number) {
    const e = randoms(count, r);
    const f = randoms(count, r);
    const R = this.radius;
    const { slot, axis: A, size: k } = er;
    const S = slot.site;
    const Nn = normalize(cross(S, A));
    const age = SHARED.clock.sub(slot.start);
    const Fa = normalize(S.sub(A.mul(k.mul(0.05))));
    const Fb = normalize(S.add(A.mul(k.mul(0.05))));
    const strand = floor(f.y.mul(9));
    const theta0 = strand.mul(2.39996);
    const rho = fract(strand.mul(0.618034)).mul(0.65).add(0.35);
    // Counter-streaming flows along the threads, as seen in real prominences.
    const flow = f.z.sub(0.5).mul(0.05);
    const height = (t: N) => k.mul(R).mul(t.mul(t).mul(0.0045).add(t.mul(0.012)).add(0.035));
    const ropeAt = (u: N, dt: number) => {
      const t = max(age.add(dt), 0);
      const H = height(t);
      const axisAt = (v: N) => {
        const arc = max(sin(v.mul(Math.PI)), 0);
        return normalize(mix(Fa, Fb, v))
          .mul(R)
          .add(S.mul(H.mul(pow(arc, 0.8))))
          .sub(A.mul(H.mul(0.35).mul(sin(v.mul(Math.PI * 2)))));
      };
      const p = axisAt(u);
      const tangent = axisAt(u.add(0.01)).sub(axisAt(u.sub(0.01)));
      const n1 = normalize(cross(tangent, Nn));
      const rc = H.mul(0.1)
        .mul(sqrt(max(sin(u.mul(Math.PI)), 0)))
        .add(R * 0.004);
      const th = theta0.add(u.mul(Math.PI * 2).mul(t.mul(0.12).add(1.2)));
      const off = n1
        .mul(cos(th))
        .add(Nn.mul(sin(th)))
        .mul(rc.mul(rho))
        .add(e.xyz.sub(0.5).mul(rc.mul(0.25)));
      const turbulence = swirl(p.div(R).mul(5).add(er.seed), t.mul(0.2)).mul(H.mul(0.07));
      return p.add(off).add(turbulence);
    };
    const u = fract(e.w.add(age.mul(flow)));
    const tailU = u.sub(sign(flow).mul(0.05));
    const H = height(max(age, 0));
    const env = smoothstep(0.2, 1.6, age)
      .mul(float(1).sub(smoothstep(9, 16, age)))
      .mul(smoothstep(0, 0.05, u))
      .mul(float(1).sub(smoothstep(0.95, 1, u)))
      .div(H.div(R).mul(2).add(1));
    const colour = mix(vec3(1.0, 0.85, 0.6).mul(1.5), vec3(1.0, 0.36, 0.12), smoothstep(0.5, 3.5, age))
      .mul(fract(strand.mul(0.381966)).mul(0.8).add(0.5))
      .mul(env)
      .mul(slot.strength.mul(0.5).add(0.5))
      .mul(2.4);
    return this.streak(ropeAt(u, 0), ropeAt(tailU, -0.25), float(R * 0.0012), colour, 0.4, count);
  }

  /**
   * Sprays of plasma shot up in a few coherent jets, each a stream of particles
   * launched one after another along the same bending path; most fall back, some
   * escape.
   */
  private buildJets(er: Eruption, count: number, r: () => number) {
    const e = randoms(count, r);
    const f = randoms(count, r);
    const R = this.radius;
    const { slot, axis: A, size: k } = er;
    const S = slot.site;
    const Nn = normalize(cross(S, A));
    const age = SHARED.clock.sub(slot.start);
    const jet = floor(f.y.mul(9)).add(er.seed.mul(13));
    const pick = (n: number) => hash(jet.mul(97).add(n));
    const phi = pick(1).mul(Math.PI * 2);
    const dir0 = normalize(
      S.add(
        A.mul(cos(phi))
          .add(Nn.mul(sin(phi)))
          .mul(pick(2).mul(0.3).add(0.04)),
      ),
    );
    // Each particle leaves at its own small angle, so a jet fans out into a sheaf of threads.
    const dir = normalize(
      dir0.add(
        A.mul(e.z.sub(0.5))
          .add(Nn.mul(e.w.sub(0.5)))
          .mul(0.07),
      ),
    );
    const v = pick(3).mul(0.11).add(0.05).mul(R).mul(k).mul(e.y.mul(0.2).add(0.9));
    const escapes = step(pick(4), 0.3);
    const apex = pick(5).mul(2.5).add(2.5);
    const g = v.div(apex).mul(float(1).sub(escapes));
    // A stream: the particles of a jet leave one after another.
    const launched = age.sub(e.x.mul(2.2));
    const heightAt = (t: N) => max(v.mul(t).sub(g.mul(t).mul(t).mul(0.5)), 0);
    const at = (dt: number) => {
      const t = max(launched.add(dt), 0);
      const h = heightAt(t);
      // The path bends with height through the swirl, the same for every particle of the jet.
      const bend = swirl(
        dir0
          .mul(4)
          .add(S.mul(h.div(R).mul(6)))
          .add(er.seed),
        age.add(dt).mul(0.1),
      );
      // Finer eddies fray the sheaf as it rises.
      const fray = swirl(dir.mul(14).add(er.seed), age.add(dt).mul(0.3));
      return dir
        .mul(h.add(R))
        .add(bend.mul(h.mul(0.3)))
        .add(fray.mul(h.mul(0.06)));
    };
    const span = mix(apex.mul(2), float(9), escapes);
    const x = launched.div(span);
    // Falling plasma fades as it drains back into the chromosphere.
    const landing = mix(smoothstep(0, R * 0.004, heightAt(max(launched, 0))), float(1), escapes);
    const env = step(0, launched)
      .mul(smoothstep(0, 0.03, x))
      .mul(float(1).sub(smoothstep(0.75, 1, x)))
      .mul(landing);
    // White-hot at launch, cooling to the deep red of prominence plasma.
    const colour = mix(vec3(1.0, 0.92, 0.75).mul(1.6), vec3(1.0, 0.3, 0.09).mul(0.8), smoothstep(0, 0.3, x))
      .mul(env)
      .mul(slot.strength.mul(0.5).add(0.5));
    return this.streak(at(0), at(-0.22), float(R * 0.0012), colour, 0.4, count);
  }

  /**
   * After the eruption, an arcade of small hot loops along the line between the
   * footpoints, growing and spreading apart as it cools, with plasma raining down
   * both legs.
   */
  private buildArcade(er: Eruption, count: number, r: () => number) {
    const e = randoms(count, r);
    const f = randoms(count, r);
    const R = this.radius;
    const { slot, axis: A, size: k } = er;
    const S = slot.site;
    const Nn = normalize(cross(S, A));
    const age = SHARED.clock.sub(slot.start);
    const ta = max(age.sub(2.5), 0);
    const loop = floor(f.y.mul(7));
    const centre = normalize(S.add(Nn.mul(loop.div(6).sub(0.5).mul(k.mul(0.09)))));
    const sep = ta.mul(0.0025).add(0.012).mul(k);
    const h = ta
      .mul(0.0035)
      .add(0.012)
      .mul(R)
      .mul(k)
      .mul(
        hash(loop.add(er.seed.mul(13)).add(5))
          .mul(0.4)
          .add(0.8),
      );
    const fa: N = normalize(centre.sub(A.mul(sep)));
    const fb: N = normalize(centre.add(A.mul(sep)));
    const side = step(0.5, f.z);
    const point = (u: N): N => {
      const s: N = mix(float(0.5), side, u.mul(u));
      const base: N = normalize(mix(fa, fb, s) as N);
      const arc: N = sin(s.mul(Math.PI));
      const strand: N = Nn.mul(e.z.sub(0.5)).add(base.mul(e.w.sub(0.5).mul(0.5)));
      return base.mul(arc.mul(h).add(R)).add(strand.mul(R * 0.003));
    };
    const u = fract(e.x.add(ta.mul(0.3)));
    const env = smoothstep(0, 2, ta)
      .mul(float(1).sub(smoothstep(13.5, 16.5, age)))
      .mul(smoothstep(0, 0.1, u))
      .mul(float(1).sub(smoothstep(0.9, 1, u)));
    const colour = mix(vec3(1.0, 0.85, 0.6).mul(1.4), vec3(1.0, 0.35, 0.12), smoothstep(0, 9, ta))
      .mul(env)
      .mul(slot.strength.mul(0.5).add(0.5))
      .mul(1.2);
    return this.streak(point(u), point(max(u.sub(0.1), 0)), float(R * 0.001), colour, 0.4, count);
  }

  /** Fraction of the particles drawn (quality setting). */
  setDensity(fraction: number) {
    const f = Math.min(1, Math.max(0.1, fraction));
    this.loops.count = Math.max(1, Math.floor(this.loopTotal * f));
    this.threads.count = Math.max(1, Math.floor(this.threadTotal * f));
    for (const e of this.eruptions) for (const p of e.parts) p.sprite.count = Math.max(1, Math.floor(p.total * f));
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
    // The filament lies roughly east-west, tilted toward the equator like the region's loops.
    const east = new THREE.Vector3(0, 1, 0).cross(site).normalize();
    const north = site.clone().cross(east);
    const tilt = (-Math.sign(reg.lat || 1) * 10 + (this.random() - 0.5) * 50) * DEG;
    free.axis.value.copy(east.multiplyScalar(Math.cos(tilt)).addScaledVector(north, Math.sin(tilt)));
    free.size.value = 0.75 + 0.5 * reg.strength * (0.7 + 0.6 * this.random());
    free.seed.value = Math.floor(this.random() * 1000);
    free.slot.start.value = clock;
    free.slot.strength.value = reg.strength;
    free.flash.position.copy(site).multiplyScalar(this.radius * 1.004);
    return reg;
  }

  /**
   * @param clock engine seconds
   * @param sunPx apparent radius of the Sun on screen (px)
   * @param pixelsPerRadian screen pixels per radian at the centre of the view
   */
  update(clock: number, sunPx: number, pixelsPerRadian: number) {
    SHARED.clock.value = clock;
    this.pxAngle.value = 1 / pixelsPerRadian;
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
      const busy = fade > 0 && age >= 0 && age <= ERUPTION_S;
      for (const p of e.parts) p.sprite.visible = busy;
    }
  }
}
