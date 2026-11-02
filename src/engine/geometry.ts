import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import * as THREE from 'three/webgpu';
import MODELS from '../data/generated/shapes.json';
import type { Shape } from '../data/types.ts';

let sphereHi: THREE.SphereGeometry | null = null;
let sphereLo: THREE.SphereGeometry | null = null;

/** Unit sphere shared by every round body. */
export function unitSphere(detail: 'hi' | 'lo' = 'hi'): THREE.SphereGeometry {
  if (detail === 'hi') {
    sphereHi ??= new THREE.SphereGeometry(1, 160, 80);
    return sphereHi;
  }
  sphereLo ??= new THREE.SphereGeometry(1, 48, 24);
  return sphereLo;
}

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sum of random spherical bumps and craters: cheap, seamless value noise on the sphere. */
function lumpField(seed: number, count: number) {
  const r = rng(seed);
  const features = Array.from({ length: count }, () => {
    const z = r() * 2 - 1;
    const t = r() * Math.PI * 2;
    const s = Math.sqrt(1 - z * z);
    return {
      d: new THREE.Vector3(s * Math.cos(t), z, s * Math.sin(t)),
      size: 0.15 + r() * 0.5,
      depth: (r() - 0.45) * 0.22,
      crater: r() < 0.55,
    };
  });
  return (n: THREE.Vector3) => {
    let h = 0;
    for (const f of features) {
      const ang = Math.acos(Math.min(1, Math.max(-1, n.dot(f.d))));
      const x = ang / f.size;
      if (x > 1.3) continue;
      if (f.crater) {
        // Bowl with a raised rim.
        h += x < 1 ? -0.08 * f.size * (1 - x * x) : 0;
        h += 0.03 * f.size * Math.exp(-((x - 1) ** 2) * 40);
      } else {
        h += f.depth * Math.exp(-x * x * 3);
      }
    }
    return h;
  };
}

function weldedIcosphere(): THREE.BufferGeometry {
  const ico = new THREE.IcosahedronGeometry(1, 6);
  ico.deleteAttribute('normal');
  ico.deleteAttribute('uv');
  return mergeVertices(ico, 1e-6);
}

function irregularLobe(radii: [number, number, number], seed: number, textured: boolean): THREE.BufferGeometry {
  // Textured bodies keep a UV sphere so equirectangular maps wrap correctly.
  // Otherwise an icosphere, welded so the displaced surface gets smooth normals.
  const geo = textured ? new THREE.SphereGeometry(1, 128, 64) : weldedIcosphere();
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const field = lumpField(seed, 70);
  const v = new THREE.Vector3();
  // Mesh axes: X = body x, Y = body pole (z), Z = −body y.
  const [ax, ay, az] = radii;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    const h = 1 + field(v);
    pos.setXYZ(i, v.x * h * ax, v.y * h * az, v.z * h * ay);
  }
  geo.computeVertexNormals();
  return geo;
}

/**
 * Geometry for irregular bodies in kilometres, normalised so its largest
 * extent is 1 (the caller scales by the body's largest radius).
 */
export function shapeGeometry(shape: Shape, seed: number, textured = false): { geometry: THREE.BufferGeometry; extent: number } {
  if (shape.type === 'ellipsoid') {
    const extent = Math.max(...shape.radii);
    const geo = irregularLobe(shape.radii.map((r) => r / extent) as [number, number, number], seed, textured);
    return { geometry: geo, extent };
  }
  const [a, b] = shape.lobes;
  const extent = a[0] + b[0];
  const ga = irregularLobe(a.map((r) => r / extent) as [number, number, number], (shape.seed ?? seed) + 1, false);
  const gb = irregularLobe(b.map((r) => r / extent) as [number, number, number], (shape.seed ?? seed) + 2, false);
  // Lobes touch along the long axis with a slight overlap to form a neck. The
  // second lobe is twisted about its own centre before it is moved into place.
  gb.rotateY(0.3);
  ga.translate(-(b[0] / extent) * 0.75, 0, 0);
  gb.translate((a[0] / extent) * 0.75, 0, 0);
  const merged = mergeGeometries([ga, gb]);
  merged.computeBoundingSphere();
  return { geometry: merged, extent: extent * 0.9 };
}

function mergeGeometries(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const parts = list.map((g) => (g.index ? g.toNonIndexed() : g));
  const total = parts.reduce((n, g) => n + g.attributes.position.count, 0);
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  let offset = 0;
  for (const g of parts) {
    position.set(g.attributes.position.array as Float32Array, offset * 3);
    normal.set(g.attributes.normal.array as Float32Array, offset * 3);
    offset += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  return out;
}

/** Flat annulus in the XZ plane (local equator) with radii in km. */
export function ringGeometry(inner: number, outer: number): THREE.BufferGeometry {
  const geo = new THREE.RingGeometry(inner, outer, 256, 4);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

/** Measured shape models built by scripts/fetch-assets.mjs, by body id: largest radius (km) and size. */
export const SHAPE_MODELS: Record<string, { radius: number; triangles: number }> = MODELS;

/**
 * Streams a measured shape model (public/shapes/<id>.bin) as geometry of unit radius in
 * the mesh axes (x, pole, −y); scale it by the model's radius.
 */
export async function loadShapeModel(id: string): Promise<THREE.BufferGeometry> {
  const res = await fetch(`${import.meta.env.BASE_URL}shapes/${id}.bin`);
  if (!res.ok) throw new Error(`${res.status} loading shapes/${id}.bin`);
  const buf = await res.arrayBuffer();
  const [magic, vertices, count] = new Uint32Array(buf, 0, 3);
  if (magic !== 0x31504853) throw new Error(`shapes/${id}.bin is not a shape model`);
  const q = new Int16Array(buf, 16, vertices * 3);
  const position = new Float32Array(vertices * 3);
  for (let i = 0; i < position.length; i++) position[i] = q[i] / 32767;
  // Positions are padded to a whole number of 4-byte words.
  const at = 16 + Math.ceil((vertices * 3) / 2) * 4;
  const index = vertices > 0xffff ? new Uint32Array(buf, at, count) : new Uint16Array(buf, at, count);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}
