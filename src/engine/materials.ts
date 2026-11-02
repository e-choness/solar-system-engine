import {
  abs,
  cameraPosition,
  dot,
  Fn,
  float,
  fwidth,
  length,
  luminance,
  max,
  mix,
  mx_fractal_noise_float,
  mx_worley_noise_float,
  normalize,
  normalMap,
  oneMinus,
  positionLocal,
  positionWorld,
  pow,
  saturate,
  smoothstep,
  step,
  texture,
  time,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import * as THREE from 'three/webgpu';
import type { BodyDef, Procedural } from '../data/types.ts';
import { MOBILE } from './device.ts';

type N = any; // TSL nodes are dynamically typed.

/**
 * Phone GPUs get cheaper fragment shaders: fewer noise octaves and at most one
 * Worley layer. A planet can fill the screen, and every noise call is per pixel.
 */
const LITE = MOBILE;

/** Scene-wide uniforms shared by every material. */
export const SHARED = {
  /** Sun position relative to the camera (scene frame, km). */
  sunPos: uniform(new THREE.Vector3()),
  /** Photosphere HDR gain: bright enough to bloom as a point, eased down as the disk fills the view. */
  sunGain: uniform(7),
  /** Corona brightness, eased down with the same curve. */
  coronaGain: uniform(1),
};

/** Per-body uniforms used for ring shadows and atmospheric scattering. */
export interface BodyUniforms {
  center: N;
  pole: N;
  radius: N;
}

export function bodyUniforms(radius: number): BodyUniforms {
  return {
    center: uniform(new THREE.Vector3()),
    pole: uniform(new THREE.Vector3(0, 1, 0)),
    radius: uniform(radius),
  };
}

const color3 = (hex: string) => {
  const c = new THREE.Color(hex);
  return vec3(c.r, c.g, c.b);
};

const sunDir = () => normalize(SHARED.sunPos.sub(positionWorld));
const viewDir = () => normalize(cameraPosition.sub(positionWorld));

/** Surface normal from the body centre: robust for both sides and displaced meshes. */
const radial = (u: BodyUniforms) => normalize(positionWorld.sub(u.center));

/**
 * How much of the twilight tint is visible along a view ray (camera → point):
 * none when the Sun is behind the camera, full when looking across or into it.
 */
const twilightView = (ray: N, L: N) => smoothstep(-0.55, 0.25, dot(ray, L));

/**
 * Procedural albedo for bodies without spacecraft imagery, evaluated on the
 * unit-sphere position so it wraps seamlessly and stays sharp at any zoom.
 */
export function proceduralAlbedo(kind: Procedural, base: string, accent: string, seed: number): N {
  const p = normalize(positionLocal).add(vec3(seed * 1.37, seed * 0.71, seed * 2.03));
  const b = color3(base);
  const a = color3(accent);
  const broad = mx_fractal_noise_float(p.mul(1.8), LITE ? 3 : 5, 2.1, 0.55)
    .mul(0.5)
    .add(0.5);
  const fine = mx_fractal_noise_float(p.mul(14), LITE ? 2 : 3, 2.0, 0.5)
    .mul(0.5)
    .add(0.5);
  const cells = mx_worley_noise_float(p.mul(LITE ? 9 : 5.5));
  const small = LITE ? cells : mx_worley_noise_float(p.mul(17));
  // Craters: dark floors, bright rims.
  const crater = (w: N, k: number) =>
    mix(float(1 - 0.45 * k), float(1), smoothstep(0.08, 0.32, w)).add(
      smoothstep(0.3, 0.36, w)
        .mul(smoothstep(0.46, 0.36, w))
        .mul(0.25 * k),
    );
  switch (kind) {
    case 'icy': {
      const cracks = oneMinus(smoothstep(0, 0.05, abs(mx_fractal_noise_float(p.mul(3.2), 3, 2, 0.5))));
      return mix(b, vec3(0.92, 0.94, 0.97), broad.mul(0.35))
        .mul(fine.mul(0.15).add(0.9))
        .mul(crater(small, 0.5))
        .sub(cracks.mul(a).mul(0.25));
    }
    case 'cratered':
      return mix(a, b, broad).mul(crater(cells, 1)).mul(crater(small, 0.7)).mul(fine.mul(0.2).add(0.85));
    case 'dusty':
      return mix(a, b, broad.mul(0.8).add(fine.mul(0.2))).mul(crater(cells, 0.4));
    case 'comet': {
      const bright = smoothstep(0.62, 0.8, broad).mul(0.35);
      return mix(b, vec3(0.32, 0.3, 0.28), bright)
        .mul(crater(small, 0.6))
        .mul(fine.mul(0.3).add(0.75));
    }
    case 'metal':
      return mix(b, a, smoothstep(0.55, 0.85, fine)).mul(crater(cells, 0.6));
    case 'charon': {
      const cap = smoothstep(0.72, 0.92, normalize(positionLocal).y);
      return mix(b.mul(crater(small, 0.6)).mul(broad.mul(0.25).add(0.85)), a, cap.mul(0.85));
    }
    default:
      return mix(a, b, broad).mul(crater(cells, 0.8)).mul(fine.mul(0.25).add(0.8));
  }
}

export interface PlanetTextures {
  map?: THREE.Texture;
  night?: THREE.Texture;
  normal?: THREE.Texture;
  specular?: THREE.Texture;
  ring?: THREE.Texture;
}

export interface PlanetMaterial {
  material: THREE.MeshStandardNodeMaterial;
  /** Texture nodes keyed by role, so higher resolutions can be swapped in. */
  nodes: Record<string, N>;
}

/** Lit surface material for planets, moons and small bodies. */
export function planetMaterial(def: BodyDef, tex: PlanetTextures, u: BodyUniforms, seed: number): PlanetMaterial {
  const v = def.visual;
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
  const nodes: Record<string, N> = {};
  const L = sunDir();
  const N = radial(u);
  const NdotL = dot(N, L);

  // A mapped world only shows this through unimaged gaps, not worth the noise on a phone.
  const fallback = LITE && tex.map ? color3(v.color) : proceduralAlbedo(v.procedural ?? 'icy', v.color, v.accent ?? v.color, seed);
  let albedo: N;
  if (tex.map) {
    nodes.map = texture(tex.map);
    albedo = nodes.map.rgb;
    if (def.id === 'titan') albedo = mix(color3(v.color), albedo.mul(color3(v.accent ?? v.color)).mul(1.3), 0.3);
    // Voyager-era maps leave unimaged regions black: fill them procedurally.
    albedo = mix(fallback, albedo, smoothstep(0.01, 0.05, luminance(albedo)));
  } else {
    albedo = fallback;
  }

  if (v.rings?.texture && tex.ring) {
    nodes.ring = texture(tex.ring);
    const n = u.pole;
    const t = dot(u.center.sub(positionWorld), n).div(dot(L, n));
    const hit = positionWorld.add(L.mul(t));
    const ru = length(hit.sub(u.center))
      .sub(v.rings.inner)
      .div(v.rings.outer - v.rings.inner);
    const a = texture(tex.ring, vec2(ru, 0.5)).a;
    const inRing = step(0, t).mul(step(0, ru)).mul(step(ru, 1));
    albedo = albedo.mul(oneMinus(a.mul(inRing).mul(0.85)));
  }
  material.colorNode = albedo;

  if (tex.specular) {
    nodes.specular = texture(tex.specular);
    material.roughnessNode = mix(float(0.92), float(0.32), nodes.specular.r);
  }
  if (tex.normal) {
    nodes.normal = texture(tex.normal);
    material.normalNode = normalMap(nodes.normal, vec2(0.8, 0.8));
  }
  if (v.procedural === 'metal') {
    material.metalnessNode = float(0.55);
    material.roughnessNode = float(0.5);
  }

  let emissive: N = vec3(0);
  if (tex.night) {
    nodes.night = texture(tex.night);
    emissive = emissive.add(nodes.night.rgb.mul(smoothstep(0.06, -0.14, NdotL)).mul(1.8));
  }
  if (v.atmosphere) {
    const V = viewDir();
    const fres = pow(oneMinus(saturate(dot(N, V))), 3);
    const day = smoothstep(-0.2, 0.45, NdotL);
    // Twilight reddening is a thin band along the terminator, seen only when the
    // camera looks across it (at full phase the whole limb sits at NdotL ≈ 0).
    const band = smoothstep(-0.16, 0, NdotL)
      .mul(smoothstep(0.16, 0, NdotL))
      .mul(twilightView(V.negate(), L));
    const sunset = color3(v.atmosphere.sunset ?? v.atmosphere.color);
    emissive = emissive.add(
      color3(v.atmosphere.color)
        .mul(fres.mul(day).mul(v.atmosphere.density * 0.9))
        .add(sunset.mul(fres.mul(band).mul(v.atmosphere.density * 0.35))),
    );
  }
  material.emissiveNode = emissive;
  return { material, nodes };
}

/** Scattering halo rendered on the back faces of a slightly larger shell. */
export function atmosphereMaterial(def: BodyDef, u: BodyUniforms): THREE.MeshBasicNodeMaterial {
  const atm = def.visual.atmosphere!;
  const H = atm.height;
  const material = new THREE.MeshBasicNodeMaterial({
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  material.colorNode = Fn(() => {
    const ray = normalize(positionWorld.sub(cameraPosition));
    const toC = u.center.sub(cameraPosition);
    const along = max(dot(toC, ray), 0);
    const closest = cameraPosition.add(ray.mul(along));
    const h = length(closest.sub(u.center)).div(u.radius);
    const glow = pow(
      saturate(
        float(1 + H)
          .sub(h)
          .div(H),
      ),
      2.4,
    );
    const L = sunDir();
    const lit = dot(normalize(closest.sub(u.center)), L);
    // Day-side scattering color everywhere except a narrow twilight band viewed across the terminator.
    const twilight = smoothstep(-0.12, 0, lit)
      .mul(smoothstep(0.14, 0, lit))
      .mul(twilightView(ray, L));
    // `h` is where the ray passes closest to the center, so (h - 1) / H is the height it grazes.
    // The upper haze takes over from about half the shell's height (Mars: ice above ~30 km; Titan: the detached layer).
    const layered = atm.high ? mix(color3(atm.color), color3(atm.high), smoothstep(0.45, 0.9, h.sub(1).div(H))) : color3(atm.color);
    const tint = mix(layered, color3(atm.sunset ?? atm.color), twilight.mul(0.85));
    const light = smoothstep(-0.3, 0.15, lit);
    const forward = pow(saturate(dot(ray, L)), 8).mul(2.5);
    return tint
      .mul(glow)
      .mul(light.add(forward))
      .mul(atm.density * 1.6);
  })();
  return material;
}

/** Earth's cloud deck: lit by the sun, alpha from the cloud map. */
export function cloudMaterial(map: THREE.Texture): { material: THREE.MeshStandardNodeMaterial; node: N } {
  const node = texture(map);
  const material = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false, roughness: 1, metalness: 0 });
  material.colorNode = vec3(1);
  material.opacityNode = smoothstep(0.08, 0.9, node.r).mul(0.95);
  return { material, node };
}

/** Planetary ring with planet shadow and lit/unlit-side shading. */
export function ringMaterial(
  def: BodyDef,
  u: BodyUniforms,
  map?: THREE.Texture,
): { material: THREE.MeshBasicNodeMaterial; node: N | null } {
  const r = def.visual.rings!;
  const material = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, transparent: true, depthWrite: false });
  const node = map ? texture(map) : null;
  const radial01 = length(positionLocal.xz)
    .sub(r.inner)
    .div(r.outer - r.inner);
  const sample = node ? texture(map!, vec2(radial01, 0.5)) : null;
  const L = sunDir();
  const V = viewDir();
  // Planet shadow: does the ray toward the Sun hit the planet sphere?
  const oc = positionWorld.sub(u.center);
  const b = dot(oc, L);
  const c = dot(oc, oc).sub(u.radius.mul(u.radius));
  const disc = b.mul(b).sub(c);
  const shadow = step(b, 0).mul(smoothstep(0, u.radius.mul(u.radius).mul(0.02), disc));
  const sameSide = step(0, dot(u.pole, L).mul(dot(u.pole, V)));
  const lighting = mix(float(0.28), float(1), sameSide)
    .mul(oneMinus(shadow.mul(0.93)))
    .add(0.02);
  const base = color3(r.color);
  // Procedural fine banding when no texture is available.
  const bands = mx_fractal_noise_float(vec3(radial01.mul(60), 0, 0), 3, 2.3, 0.6)
    .mul(0.5)
    .add(0.5);
  let albedo = sample ? sample.rgb.mul(base).mul(1.25) : base.mul(bands.mul(0.6).add(0.4));
  let alpha = sample ? sample.a : bands.mul(smoothstep(0, 0.08, radial01)).mul(smoothstep(1, 0.92, radial01));
  if (r.ringlets && !sample) {
    // Narrow rings, most far thinner than a pixel: each draws at least a pixel
    // wide and fades with the share of the pixel it covers (square-rooted, so
    // the brightest stay visible as faint threads from a distance, as in long exposures).
    const radius = length(positionLocal.xz);
    const px = max(fwidth(radius), 1e-3);
    alpha = r.ringlets
      .map(([at, width, opacity]) => {
        const half = max(px, width).mul(0.5);
        const profile = oneMinus(smoothstep(half.sub(px.mul(0.5)), half.add(px.mul(0.5)), abs(radius.sub(at))));
        return profile.mul(saturate(float(width).div(px)).sqrt()).mul(opacity);
      })
      .reduce((sum, a) => sum.add(a));
    albedo = base;
  }
  material.colorNode = albedo.mul(lighting);
  material.opacityNode = alpha.mul(r.opacity).mul(step(0, radial01)).mul(step(radial01, 1));
  return { material, node };
}

/** Animated photosphere: texture + boiling granulation + limb darkening, in HDR. */
export function sunMaterial(map: THREE.Texture, u: BodyUniforms): { material: THREE.MeshBasicNodeMaterial; node: N } {
  const node = texture(map);
  const material = new THREE.MeshBasicNodeMaterial();
  const p = normalize(positionLocal);
  const gran = mx_fractal_noise_float(p.mul(9).add(vec3(time.mul(0.015), time.mul(-0.01), time.mul(0.012))), LITE ? 2 : 4, 2.3, 0.55)
    .mul(0.5)
    .add(0.5);
  const cells = LITE
    ? float(0.97)
    : smoothstep(0, 0.6, mx_worley_noise_float(p.mul(42).add(vec3(time.mul(0.02)))))
        .mul(0.25)
        .add(0.8);
  const mu = saturate(dot(radial(u), viewDir()));
  const limb = pow(mu, 0.5).mul(0.75).add(0.25);
  const hot = vec3(1.0, 0.62, 0.22);
  const surface = node.rgb
    .mul(1.1)
    .add(hot.mul(gran.mul(0.55)))
    .mul(cells);
  material.colorNode = surface.mul(limb).mul(SHARED.sunGain);
  return { material, node };
}

/** Soft corona sprite around the Sun. */
export function coronaMaterial(): THREE.SpriteNodeMaterial {
  const material = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const d = length(uv().sub(0.5)).mul(2);
  const angle = uv().sub(0.5);
  const streamers = mx_fractal_noise_float(vec3(angle.x.mul(3), angle.y.mul(3), time.mul(0.03)), LITE ? 2 : 3, 2, 0.5)
    .mul(0.5)
    .add(0.5);
  const inner = pow(saturate(oneMinus(d)), 6).mul(3);
  const outer = pow(saturate(oneMinus(d)), 2.2)
    .mul(streamers.mul(0.6).add(0.4))
    .mul(0.6);
  material.colorNode = vec3(1.0, 0.78, 0.5).mul(inner.add(outer)).mul(SHARED.coronaGain);
  return material;
}
