import * as THREE from 'three/webgpu';
import { ECL_TO_SCENE, type Mat3, mulMM, SCENE_TO_ECL, type Vec3 } from './astro.ts';
import { loadShapeModel, ringGeometry, SHAPE_MODELS, shapeGeometry, unitSphere } from './geometry.ts';
import {
  atmosphereMaterial,
  type BodyUniforms,
  bodyUniforms,
  chromosphereMaterial,
  cloudMaterial,
  coronaMaterial,
  type PlanetTextures,
  planetMaterial,
  ringMaterial,
  sunMaterial,
} from './materials.ts';
import type { BodyState } from './system.ts';
import type { TextureBank } from './textures.ts';

/** Polar flattening for visibly oblate bodies. */
const FLATTENING: Record<string, number> = {
  jupiter: 0.06487,
  saturn: 0.09796,
  uranus: 0.02293,
  neptune: 0.01708,
  earth: 0.00335,
  mars: 0.00589,
};

/** Height of the spicule fringe above the solar limb, as a fraction of the radius (about 14,000 km). */
const CHROMOSPHERE = 0.02;

const m4 = new THREE.Matrix4();

export class BodyView {
  readonly state: BodyState;
  readonly group = new THREE.Group();
  readonly mesh: THREE.Mesh;
  readonly uniforms: BodyUniforms;
  /** Largest extent incl. atmosphere (km) — used for camera limits and picking. */
  readonly extent: number;
  /** Largest extent incl. rings (km). */
  readonly outerExtent: number;
  readonly textureIds: string[] = [];
  private clouds?: THREE.Mesh;
  private atmosphere?: THREE.Mesh;
  private rings?: THREE.Mesh;
  private corona?: THREE.Sprite;
  private readonly swaps: Array<[string, any]> = [];
  private highRequested = false;
  /** A measured shape model replacing the procedural one, streamed once the body is in view. */
  private readonly model?: { radius: number; triangles: number };
  private modelRequested = false;

  constructor(state: BodyState, bank: TextureBank, seed: number) {
    this.state = state;
    const def = state.def;
    const v = def.visual;
    const R = def.physical.radius;
    this.uniforms = bodyUniforms(R);
    this.group.name = def.id;

    const tex = (id?: string) => {
      if (!id || !bank.has(id)) return undefined;
      this.textureIds.push(id);
      return bank.get(id);
    };
    const textures: PlanetTextures = {
      map: tex(v.map),
      night: tex(v.night),
      normal: tex(v.normal),
      specular: tex(v.specular),
      ring: tex(v.rings?.texture),
    };

    if (def.kind === 'star') {
      const { material, node } = sunMaterial(textures.map!, this.uniforms);
      this.swaps.push([v.map!, node]);
      this.mesh = new THREE.Mesh(unitSphere('hi'), material);
      this.mesh.scale.setScalar(R);
      this.corona = new THREE.Sprite(coronaMaterial());
      this.corona.scale.set(R * 16, R * 16, 1);
      this.corona.renderOrder = 2;
      this.group.add(this.corona);
      const chromosphere = new THREE.Mesh(unitSphere('hi'), chromosphereMaterial(this.uniforms, CHROMOSPHERE));
      chromosphere.scale.setScalar(R * (1 + CHROMOSPHERE));
      chromosphere.renderOrder = 3;
      this.group.add(chromosphere);
    } else {
      const { material, nodes } = planetMaterial(def, textures, this.uniforms, seed);
      for (const [role, node] of Object.entries(nodes)) {
        const id = role === 'map' ? v.map : role === 'ring' ? v.rings?.texture : (v as any)[role];
        if (id) this.swaps.push([id, node]);
      }
      if (def.shape) {
        this.model = textures.map ? undefined : SHAPE_MODELS[def.id];
        const { geometry, extent } = shapeGeometry(def.shape, seed, Boolean(textures.map));
        this.mesh = new THREE.Mesh(geometry, material);
        this.mesh.scale.setScalar(extent);
      } else {
        this.mesh = new THREE.Mesh(unitSphere(R > 200 ? 'hi' : 'lo'), material);
        this.mesh.scale.set(R, R * (1 - (FLATTENING[def.id] ?? 0)), R);
      }
    }
    this.group.add(this.mesh);

    const flat = 1 - (FLATTENING[def.id] ?? 0);
    if (v.clouds && bank.has(v.clouds)) {
      const { material, node } = cloudMaterial(tex(v.clouds)!);
      this.swaps.push([v.clouds, node]);
      this.clouds = new THREE.Mesh(unitSphere('hi'), material);
      this.clouds.scale.set(R * 1.006, R * 1.006 * flat, R * 1.006);
      this.clouds.renderOrder = 1;
      this.group.add(this.clouds);
    }
    if (v.atmosphere) {
      const s = R * (1 + v.atmosphere.height);
      this.atmosphere = new THREE.Mesh(unitSphere('lo'), atmosphereMaterial(def, this.uniforms));
      this.atmosphere.scale.set(s, s * flat, s);
      this.atmosphere.renderOrder = 3;
      this.group.add(this.atmosphere);
    }
    if (v.rings) {
      const { material, node } = ringMaterial(def, this.uniforms, textures.ring);
      if (node && v.rings.texture) this.swaps.push([v.rings.texture, node]);
      this.rings = new THREE.Mesh(ringGeometry(v.rings.inner, v.rings.outer), material);
      this.rings.renderOrder = 4;
      this.group.add(this.rings);
    }

    const shapeR = def.shape
      ? def.shape.type === 'ellipsoid'
        ? Math.max(...def.shape.radii)
        : def.shape.lobes[0][0] + def.shape.lobes[1][0]
      : R;
    // The camera keeps clear of the measured surface, which can reach past the procedural one.
    const modelR = Math.max(shapeR, this.model?.radius ?? 0);
    this.extent = modelR * (1 + (v.atmosphere?.height ?? 0));
    this.outerExtent = Math.max(this.extent, v.rings?.outer ?? 0);

    for (const [id, node] of this.swaps) bank.onUpgrade(id, (t) => (node.value = t));
  }

  /** Streams full-resolution textures and the measured shape for this body. */
  requestHighRes(bank: TextureBank) {
    this.requestShape();
    // A bank that evicts needs to hear which maps are still in use.
    if (this.highRequested && !bank.evicts) return;
    this.highRequested = true;
    for (const id of new Set(this.textureIds)) bank.upgrade(id);
  }

  /** Swaps the procedural lumps for the measured shape model, if this body has one. */
  requestShape() {
    const model = this.model;
    if (!model || this.modelRequested) return;
    this.modelRequested = true;
    loadShapeModel(this.state.def.id).then(
      (geometry) => {
        const old = this.mesh.geometry;
        this.mesh.geometry = geometry;
        this.mesh.scale.setScalar(model.radius);
        old.dispose();
      },
      (err) => console.warn(`Keeping the procedural shape of ${this.state.def.id}:`, err),
    );
  }

  /**
   * Places the body relative to the camera (floating origin) and orients it.
   * `cam` is the camera position in heliocentric ecliptic km.
   */
  update(cam: Vec3, seconds: number, pixelsPerRadian: number) {
    const p = this.state.pos;
    const rx = p[0] - cam[0];
    const ry = p[1] - cam[1];
    const rz = p[2] - cam[2];
    this.group.position.set(rx, rz, -ry);
    const r: Mat3 = mulMM(ECL_TO_SCENE, mulMM(this.state.rotation, SCENE_TO_ECL));
    m4.set(r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, 0, 0, 0, 1);
    this.group.quaternion.setFromRotationMatrix(m4);

    this.uniforms.center.value.copy(this.group.position);
    // Local +Y is the body's north pole (S·M·Sᵀ maps scene-local Y to body z).
    this.uniforms.pole.value.set(r[1], r[4], r[7]);

    const dist = Math.hypot(rx, ry, rz);
    const px = (this.outerExtent / Math.max(dist, 1e-6)) * pixelsPerRadian;
    // Skip draw calls for bodies that are well below a pixel; markers take over.
    this.group.visible = px > 0.35;
    if (this.clouds) this.clouds.rotation.y = seconds * 0.0006;
    return { dist, px: (this.extent / Math.max(dist, 1e-6)) * pixelsPerRadian };
  }
}
