import {
  cos,
  equirectUV,
  exp,
  float,
  fract,
  instancedBufferAttribute,
  length,
  mix,
  modelViewMatrix,
  normalize,
  positionWorldDirection,
  pow,
  saturate,
  sin,
  smoothstep,
  sqrt,
  step,
  texture,
  time,
  uniform,
  uv,
  varying,
  vec3,
  vec4,
} from 'three/tsl';
import * as THREE from 'three/webgpu';
import { PLANET_ELEMENTS } from '../data/planet-elements.ts';
import { AU_KM, EQ_TO_ECL, EQ_TO_GAL, type Mat3, mulMM, SCENE_TO_ECL, transpose } from './astro.ts';
import { rng } from './geometry.ts';

type N = any;

/** Soft round falloff for sprite particles: 1 at the centre, 0 at the edge. */
const disc = () => {
  const d = length(uv().sub(0.5)).mul(2);
  return exp(d.mul(d).mul(-5)).sub(0.0067).max(0);
};

function instanced(array: Float32Array, size: number, dynamic = false) {
  const a = new THREE.InstancedBufferAttribute(array, size);
  if (dynamic) a.setUsage(THREE.DynamicDrawUsage);
  return a;
}

// ───────────────────────────────────────────────────────────── body markers

/** One glowing point per body: keeps far-away worlds visible at true scale. */
export class Markers {
  readonly sprite: THREE.Sprite;
  private readonly pos: THREE.InstancedBufferAttribute;
  private readonly color: THREE.InstancedBufferAttribute;
  private readonly size: THREE.InstancedBufferAttribute;
  private readonly alpha: THREE.InstancedBufferAttribute;

  constructor(count: number) {
    this.pos = instanced(new Float32Array(count * 3), 3, true);
    this.color = instanced(new Float32Array(count * 3), 3, true);
    this.size = instanced(new Float32Array(count), 1, true);
    this.alpha = instanced(new Float32Array(count), 1, true);
    const m = new THREE.PointsNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: false,
    });
    m.positionNode = instancedBufferAttribute<'vec3'>(this.pos, 'vec3');
    m.sizeNode = instancedBufferAttribute<'float'>(this.size, 'float');
    const glow = disc();
    m.colorNode = instancedBufferAttribute<'vec3'>(this.color, 'vec3').mul(glow.mul(1.6));
    m.opacityNode = instancedBufferAttribute<'float'>(this.alpha, 'float').mul(glow);
    this.sprite = new THREE.Sprite(m);
    this.sprite.count = count;
    this.sprite.frustumCulled = false;
    this.sprite.renderOrder = 5;
  }

  set(i: number, x: number, y: number, z: number, c: THREE.Color, sizePx: number, alpha: number) {
    this.pos.setXYZ(i, x, y, z);
    this.color.setXYZ(i, c.r, c.g, c.b);
    this.size.setX(i, sizePx);
    this.alpha.setX(i, alpha);
  }

  commit() {
    this.pos.needsUpdate = true;
    this.color.needsUpdate = true;
    this.size.needsUpdate = true;
    this.alpha.needsUpdate = true;
  }
}

// ───────────────────────────────────────────────────────────── belts

export type BeltKind = 'main' | 'trojans' | 'kuiper' | 'oort';

const GAUSS_DEG_PER_DAY = 0.9856076686; // n = k / a^1.5 for a in AU

function rayleigh(r: () => number, sigma: number) {
  return sigma * Math.sqrt(-2 * Math.log(1 - r() * 0.999999));
}

/** Kirkwood gaps carved out of the main belt by Jupiter resonances (AU, half-width). */
const KIRKWOOD: Array<[number, number]> = [
  [2.065, 0.03],
  [2.502, 0.025],
  [2.825, 0.018],
  [2.958, 0.012],
  [3.279, 0.03],
];

function sampleElements(kind: BeltKind, r: () => number) {
  const TAU = Math.PI * 2;
  switch (kind) {
    case 'main': {
      let a = 0;
      do a = 2.1 + r() * 1.25;
      while (KIRKWOOD.some(([g, w]) => Math.abs(a - g) < w) || (a > 3.0 && r() < (a - 3.0) * 2.2));
      return {
        a,
        e: Math.min(0.32, rayleigh(r, 0.09)),
        i: Math.min(30, rayleigh(r, 7)),
        node: r() * TAU,
        peri: r() * TAU,
        M: r() * TAU,
        size: 1 + r() * 1.1,
      };
    }
    case 'trojans': {
      // Share Jupiter's mean longitude ±60°, librating around L4/L5.
      const jup = PLANET_ELEMENTS.jupiter;
      const lead = r() < 0.6 ? 60 : -60;
      const lambda = ((jup.L[0] + lead + (r() - 0.5) * 50) * Math.PI) / 180;
      const node = r() * TAU;
      const peri = r() * TAU;
      return {
        a: 5.2026 + (r() - 0.5) * 0.3,
        e: Math.min(0.15, rayleigh(r, 0.05)),
        i: Math.min(35, rayleigh(r, 11)),
        node,
        peri,
        M: lambda - node - peri,
        size: 1 + r(),
      };
    }
    case 'kuiper': {
      const plutino = r() < 0.25;
      const a = plutino ? 39.4 + (r() - 0.5) * 0.6 : 42 + r() * 6.5;
      const hot = r() < 0.4;
      return {
        a,
        e: plutino ? 0.1 + r() * 0.2 : Math.min(0.2, rayleigh(r, 0.05)),
        i: hot ? Math.min(35, rayleigh(r, 14)) : rayleigh(r, 2.5),
        node: r() * TAU,
        peri: r() * TAU,
        M: r() * TAU,
        size: 1 + r() * 0.8,
      };
    }
    case 'oort': {
      // Spherical shell, 2,000–100,000 AU, denser inward (static: periods are millions of years).
      const a = 2000 * Math.exp(r() * Math.log(50));
      return { a, e: 0, i: Math.acos(2 * r() - 1) * (180 / Math.PI), node: r() * TAU, peri: r() * TAU, M: r() * TAU, size: 1 + r() * 0.8 };
    }
  }
}

const BELT_STYLE: Record<BeltKind, { color: string; alpha: number }> = {
  main: { color: '#c9b49a', alpha: 0.5 },
  trojans: { color: '#b9a688', alpha: 0.45 },
  kuiper: { color: '#9fb6d6', alpha: 0.38 },
  oort: { color: '#8aa6d0', alpha: 0.22 },
};

/**
 * A belt of small bodies whose Keplerian orbits are solved per-vertex on the
 * GPU, so tens of thousands of particles move correctly through time.
 */
export class Belt {
  readonly sprite: THREE.Sprite;
  readonly total: number;
  /** Sun position relative to the camera (scene frame). */
  readonly sunRel = uniform(new THREE.Vector3());
  /** Days since J2000. */
  readonly days = uniform(0);
  readonly fade = uniform(1);

  constructor(kind: BeltKind, count: number, seed: number) {
    const r = rng(seed);
    this.total = count;
    const A = new Float32Array(count * 4);
    const B = new Float32Array(count * 4);
    const DEG = Math.PI / 180;
    for (let k = 0; k < count; k++) {
      const el = sampleElements(kind, r);
      const n = kind === 'oort' ? 0 : ((GAUSS_DEG_PER_DAY / el.a ** 1.5) * Math.PI) / 180;
      A.set([el.a * AU_KM, el.e, el.i * DEG, el.node], k * 4);
      B.set([el.peri, el.M, n, el.size], k * 4);
    }
    const ea = instancedBufferAttribute<'vec4'>(instanced(A, 4), 'vec4');
    const eb = instancedBufferAttribute<'vec4'>(instanced(B, 4), 'vec4');
    const a = ea.x;
    const e = ea.y;
    const inc = ea.z;
    const node = ea.w;
    const peri = eb.x;
    const M = eb.y.add(eb.z.mul(this.days)).mod(Math.PI * 2);
    // Newton iterations for Kepler's equation, unrolled.
    let E: N = M.add(e.mul(sin(M)));
    for (let k = 0; k < 4; k++)
      E = E.sub(
        E.sub(e.mul(sin(E)))
          .sub(M)
          .div(float(1).sub(e.mul(cos(E)))),
      );
    const xp = a.mul(cos(E).sub(e));
    const yp = a.mul(sqrt(float(1).sub(e.mul(e)))).mul(sin(E));
    const cO = cos(node);
    const sO = sin(node);
    const ci = cos(inc);
    const si = sin(inc);
    const cw = cos(peri);
    const sw = sin(peri);
    const x = cO
      .mul(cw)
      .sub(sO.mul(sw).mul(ci))
      .mul(xp)
      .add(cO.negate().mul(sw).sub(sO.mul(cw).mul(ci)).mul(yp));
    const y = sO
      .mul(cw)
      .add(cO.mul(sw).mul(ci))
      .mul(xp)
      .add(sO.negate().mul(sw).add(cO.mul(cw).mul(ci)).mul(yp));
    const z = sw.mul(si).mul(xp).add(cw.mul(si).mul(yp));

    const style = BELT_STYLE[kind];
    const m = new THREE.PointsNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: false,
    });
    m.positionNode = vec3(x, z, y.negate()).add(this.sunRel);
    m.sizeNode = eb.w.mul(1.15);
    const c = new THREE.Color(style.color);
    m.colorNode = vec3(c.r, c.g, c.b).mul(disc());
    m.opacityNode = disc().mul(style.alpha).mul(this.fade);
    this.sprite = new THREE.Sprite(m);
    this.sprite.count = count;
    this.sprite.frustumCulled = false;
    this.sprite.renderOrder = -1;
  }

  setDensity(fraction: number) {
    this.sprite.count = Math.max(1, Math.floor(this.total * fraction));
  }
}

// ───────────────────────────────────────────────────────────── comet tails

/** Ion + dust tails and coma, oriented away from the Sun each frame. */
export class CometTail {
  readonly group = new THREE.Group();
  readonly anti = uniform(new THREE.Vector3(1, 0, 0));
  readonly vel = uniform(new THREE.Vector3(0, 0, 1));
  readonly lengthKm = uniform(1);
  readonly activity = uniform(0);
  private readonly comaFade = uniform(1);
  private readonly tail: THREE.Sprite;
  private readonly coma: THREE.Sprite;

  constructor(count: number, seed: number) {
    const r = rng(seed);
    const seeds = new Float32Array(count * 4).map(() => r());
    const s = instancedBufferAttribute<'vec4'>(instanced(seeds, 4), 'vec4');
    const ion = step(s.w, 0.45);
    const speed = mix(float(0.05), float(0.12), s.y);
    const age = fract(s.x.add(time.mul(speed)));
    const jitter = vec3(s.y.sub(0.5), s.z.sub(0.5), fract(s.y.mul(7.31).add(s.z.mul(3.17))).sub(0.5));
    const L = this.lengthKm;
    const ionPos = this.anti.mul(age.mul(L)).add(jitter.mul(age.mul(L).mul(0.035)));
    const dustPos = this.anti
      .mul(age.mul(L).mul(0.72))
      .sub(this.vel.mul(age.mul(age).mul(L).mul(0.28)))
      .add(jitter.mul(age.mul(L).mul(0.14)));

    const m = new THREE.PointsNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    const pos = mix(dustPos, ionPos, ion);
    const size = L.mul(mix(float(0.03), float(0.11), age)).mul(mix(float(1), float(0.5), ion));
    m.positionNode = pos;
    m.sizeNode = size;
    m.colorNode = mix(vec3(1.0, 0.93, 0.8), vec3(0.45, 0.72, 1.0), ion).mul(disc());
    const fadeIn = smoothstep(0, 0.04, age);
    // Puffs the camera sits in would wash out the whole view: fade them by apparent size.
    const near = varying(float(1).sub(smoothstep(0.1, 0.5, size.div(length(modelViewMatrix.mul(vec4(pos, 1)).xyz)))));
    m.opacityNode = pow(float(1).sub(age), 1.6)
      .mul(fadeIn)
      .mul(near)
      .mul(this.activity)
      .mul(mix(float(0.16), float(0.22), ion))
      .mul(disc());
    this.tail = new THREE.Sprite(m);
    this.tail.count = count;
    this.tail.frustumCulled = false;
    this.tail.renderOrder = 6;

    const cm = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const d = length(uv().sub(0.5)).mul(2);
    cm.colorNode = vec3(0.75, 0.88, 1.0).mul(
      pow(saturate(float(1).sub(d)), 3)
        .mul(1.4)
        .mul(this.activity)
        .mul(this.comaFade),
    );
    this.coma = new THREE.Sprite(cm);
    this.coma.renderOrder = 6;
    this.group.add(this.tail, this.coma);
  }

  /**
   * @param anti unit vector away from the Sun (scene frame)
   * @param vel unit velocity (scene frame)
   * @param rAu heliocentric distance
   */
  update(anti: THREE.Vector3, vel: THREE.Vector3, rAu: number, nucleusKm: number) {
    const act = Math.min(1, Math.max(0, (4.5 - rAu) / 3.5)) ** 1.6;
    this.activity.value = act;
    this.anti.value.copy(anti);
    this.vel.value.copy(vel);
    const len = 3.2e7 * act * Math.max(0.6, (nucleusKm / 5) ** 0.35);
    this.lengthKm.value = Math.max(len, 1);
    this.group.visible = act > 0.002;
    const comaSize = Math.max(len * 0.035, nucleusKm * 40);
    this.coma.scale.set(comaSize, comaSize, 1);
    // Up close the coma sprite would fill the screen: fade it by apparent size (the group sits at the nucleus, camera-relative).
    this.comaFade.value = 1 - THREE.MathUtils.smoothstep(comaSize / Math.max(this.group.position.length(), 1), 0.12, 0.7);
  }
}

// ───────────────────────────────────────────────────────────── sky

/** Rotation that maps a scene-frame direction into the galactic texture frame. */
function galacticTextureMatrix(): THREE.Matrix3 {
  const eclToEq = transpose(EQ_TO_ECL);
  const texFromGal: Mat3 = [1, 0, 0, 0, 0, 1, 0, -1, 0];
  const m = mulMM(texFromGal, mulMM(EQ_TO_GAL, mulMM(eclToEq, SCENE_TO_ECL)));
  return new THREE.Matrix3().set(...m);
}

/** B−V color index → approximate sRGB star color. */
function starColor(bv: number): [number, number, number] {
  const stops: Array<[number, [number, number, number]]> = [
    [-0.4, [0.62, 0.72, 1.0]],
    [0.0, [0.8, 0.86, 1.0]],
    [0.4, [0.97, 0.96, 0.98]],
    [0.65, [1.0, 0.94, 0.84]],
    [1.0, [1.0, 0.84, 0.64]],
    [1.5, [1.0, 0.72, 0.46]],
    [2.0, [1.0, 0.62, 0.36]],
  ];
  const x = Math.min(2, Math.max(-0.4, bv));
  for (let k = 1; k < stops.length; k++) {
    if (x <= stops[k][0]) {
      const [x0, c0] = stops[k - 1];
      const [x1, c1] = stops[k];
      const t = (x - x0) / (x1 - x0);
      return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t];
    }
  }
  return stops.at(-1)![1];
}

export class Sky {
  readonly milkyWay = uniform(0.55);
  readonly starBrightness = uniform(1);
  readonly backgroundNode: N;
  stars: THREE.Sprite | null = null;

  constructor(milkyWayTexture: THREE.Texture) {
    const rot = uniform(galacticTextureMatrix());
    this.backgroundNode = texture(milkyWayTexture, equirectUV(normalize(rot.mul(positionWorldDirection)))).rgb.mul(this.milkyWay);
  }

  /** Builds crisp catalogue stars from public/data/stars.bin (x, y, z, mag, B−V in J2000 equatorial). */
  buildStars(data: Float32Array) {
    const count = data.length / 5;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const R = 1e14;
    const [a, b, c, d, e, f, g, h, i] = EQ_TO_ECL;
    for (let k = 0; k < count; k++) {
      const x = data[k * 5];
      const y = data[k * 5 + 1];
      const z = data[k * 5 + 2];
      const mag = data[k * 5 + 3];
      const ex = a * x + b * y + c * z;
      const ey = d * x + e * y + f * z;
      const ez = g * x + h * y + i * z;
      pos.set([ex * R, ez * R, -ey * R], k * 3);
      const bright = Math.min(1, Math.max(0.18, 0.28 + (6.5 - mag) * 0.14));
      const [cr, cg, cb] = starColor(data[k * 5 + 4]);
      col.set([cr * bright, cg * bright, cb * bright], k * 3);
      size[k] = Math.min(6.5, Math.max(1.4, 1.2 + (6.5 - mag) * 0.62));
    }
    const m = new THREE.PointsNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: false,
    });
    m.positionNode = instancedBufferAttribute<'vec3'>(instanced(pos, 3), 'vec3');
    m.sizeNode = instancedBufferAttribute<'float'>(instanced(size, 1), 'float');
    m.colorNode = instancedBufferAttribute<'vec3'>(instanced(col, 3), 'vec3').mul(disc()).mul(this.starBrightness);
    m.opacityNode = disc();
    this.stars = new THREE.Sprite(m);
    this.stars.count = count;
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -3;
    return this.stars;
  }
}
