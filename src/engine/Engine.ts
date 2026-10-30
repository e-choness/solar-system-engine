import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js';
import { lensflare } from 'three/addons/tsl/display/LensflareNode.js';
import { float, pass, uniform } from 'three/tsl';
import * as THREE from 'three/webgpu';
import type { BodyKind } from '../data/types.ts';
import { AU_KM, dateFromJd, J2000, jdFromDate, length, type Vec3 } from './astro.ts';
import { BodyView } from './bodies.ts';
import { CameraRig } from './camera.ts';
import { type LabelFrame, LabelLayer } from './labels.ts';
import { SHARED } from './materials.ts';
import { Orbits } from './orbits.ts';
import { Belt, CometTail, Markers, Sky } from './particles.ts';
import { QUALITY, type Settings } from './settings.ts';
import { type BodyState, SolarSystem } from './system.ts';
import { TextureBank } from './textures.ts';

export interface Telemetry {
  jd: number;
  rate: number;
  paused: boolean;
  focusId: string;
  selectedId: string | null;
  flying: boolean;
  /** Camera distance from the focused body's centre (km). */
  focusDistance: number;
  /** Camera distance from the Sun (km). */
  sunDistance: number;
  fps: number;
}

export interface BodyLive {
  sunDistanceKm: number;
  cameraDistanceKm: number;
  parentDistanceKm: number | null;
  speedKms: number;
}

type Listener<T> = (value: T) => void;
interface EngineEvents {
  frame: Telemetry;
  select: string | null;
  hover: string | null;
  flight: { to: string; duration: number };
  arrive: string;
}

const KIND_PRIORITY: Record<BodyKind, number> = { star: 0, planet: 10, dwarf: 30, moon: 40, asteroid: 50, comet: 45 };
const MARKER_SIZE: Record<BodyKind, number> = { star: 20, planet: 7, dwarf: 5, moon: 4, asteroid: 3.5, comet: 4.5 };

/** Valid date window of the planetary theory (JPL approximate elements). */
export const JD_MIN = jdFromDate(new Date('1800-01-01T00:00:00Z'));
export const JD_MAX = jdFromDate(new Date('2200-01-01T00:00:00Z'));

export class Engine {
  readonly system = new SolarSystem();
  renderer!: THREE.WebGPURenderer;
  backend: 'WebGPU' | 'WebGL 2' = 'WebGPU';
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(50, 1, 1e-3, 1e15);
  private pipeline!: THREE.RenderPipeline;
  private pipelineNodes!: { plain: any; full: any; flareGain: any; bloom: any };
  private bank!: TextureBank;
  private readonly views = new Map<string, BodyView>();
  private orbits!: Orbits;
  private markers!: Markers;
  private belts: Belt[] = [];
  private readonly tails = new Map<string, CometTail>();
  private sky!: Sky;
  private labels!: LabelLayer;
  private light!: THREE.PointLight;
  rig!: CameraRig;

  jd = jdFromDate(new Date());
  rate = 1;
  paused = false;
  selectedId: string | null = null;
  hoveredId: string | null = null;
  private settings!: Settings;
  private readonly listeners: { [K in keyof EngineEvents]?: Array<Listener<EngineEvents[K]>> } = {};
  private lastTime = 0;
  private elapsed = 0;
  private telemetryClock = 0;
  private fpsSmooth = 60;
  /** Frames rendered since start (lets scripted captures wait for real frames). */
  frames = 0;
  private pixelsPerRadian = 1000;
  private width = 1;
  private height = 1;
  private container!: HTMLElement;
  private readonly tmpColor = new THREE.Color();
  private readonly screen = new Map<string, { x: number; y: number; z: number; front: boolean; px: number; dist: number }>();

  on<K extends keyof EngineEvents>(event: K, fn: Listener<EngineEvents[K]>) {
    if (!this.listeners[event]) this.listeners[event] = [];
    const list = this.listeners[event] as Array<Listener<EngineEvents[K]>>;
    list.push(fn);
    return () => {
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
  }

  private emit<K extends keyof EngineEvents>(event: K, value: EngineEvents[K]) {
    for (const fn of (this.listeners[event] ?? []) as Array<Listener<EngineEvents[K]>>) fn(value);
  }

  // ─────────────────────────────────────────────────────────── setup

  async init(container: HTMLElement, labelRoot: HTMLElement, settings: Settings, onProgress: (p: number, label: string) => void) {
    this.container = container;
    this.settings = { ...settings };
    this.renderer = new THREE.WebGPURenderer({ antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
    await this.renderer.init();
    this.backend = (this.renderer.backend as any).isWebGPUBackend ? 'WebGPU' : 'WebGL 2';
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.setClearColor(0x000000, 1);
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.classList.add('viewport');

    this.bank = new TextureBank((done, total) => onProgress(0.05 + 0.8 * (done / total), 'Loading planetary maps'));
    this.bank.setAnisotropy(QUALITY[settings.quality].anisotropy);
    const ids = new Set<string>(['stars']);
    for (const b of this.system.bodies) {
      const v = b.def.visual;
      for (const id of [v.map, v.night, v.clouds, v.normal, v.specular, v.rings?.texture]) if (id) ids.add(id);
    }
    await this.bank.preload([...ids]);

    onProgress(0.88, 'Charting the stars');
    const starData = new Float32Array(await (await fetch(`${import.meta.env.BASE_URL}data/stars.bin`)).arrayBuffer());

    onProgress(0.92, 'Assembling the solar system');
    this.buildScene(starData, labelRoot);
    this.buildPipeline();
    this.applySettings(settings);
    this.bindInput();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(container);

    this.system.update(this.jd);
    // Opening shot: the inner solar system from above the ecliptic.
    this.rig.jumpTo(this.system.get('sun')!, 4.2 * AU_KM);
    this.rig.pitch = 0.62;
    this.rig.yaw = 2.2;
    onProgress(1, 'Ready');
  }

  private buildScene(starData: Float32Array, labelRoot: HTMLElement) {
    const bodies = this.system.bodies;
    bodies.forEach((b, i) => {
      const view = new BodyView(b, this.bank, i * 7 + 3);
      this.views.set(b.def.id, view);
      this.scene.add(view.group);
      if (b.def.kind === 'comet') {
        const tail = new CometTail(4000, i * 13 + 1);
        this.tails.set(b.def.id, tail);
        this.scene.add(tail.group);
      }
    });

    this.light = new THREE.PointLight(0xfff4e8, 2.9, 0, 0);
    this.scene.add(this.light, new THREE.AmbientLight(0x8090b0, 0.035));

    this.orbits = new Orbits(bodies);
    this.scene.add(this.orbits.group);
    this.markers = new Markers(bodies.length);
    this.scene.add(this.markers.sprite);

    this.belts = [new Belt('main', 42000, 11), new Belt('trojans', 9000, 23), new Belt('kuiper', 26000, 37), new Belt('oort', 18000, 51)];
    for (const belt of this.belts) this.scene.add(belt.sprite);

    this.sky = new Sky(this.bank.get('stars'));
    this.bank.onUpgrade('stars', (t) => (this.sky.backgroundNode.value = t));
    this.scene.backgroundNode = this.sky.backgroundNode;
    this.scene.add(this.sky.buildStars(starData));

    const sun = this.system.get('sun')!;
    this.rig = new CameraRig(this.camera, sun, 4 * AU_KM);
    this.rig.onArrive = (b) => this.emit('arrive', b.def.id);

    this.labels = new LabelLayer(
      labelRoot,
      bodies.map((b) => ({ id: b.def.id, name: b.def.name, kind: b.def.kind })),
      { select: (id) => this.select(id), focus: (id) => this.focus(id), hover: (id) => this.setHover(id) },
    );
  }

  private buildPipeline() {
    this.pipeline = new THREE.RenderPipeline(this.renderer);
    const scenePass = pass(this.scene, this.camera);
    const color = scenePass.getTextureNode('output');
    const glow = bloom(color, 0.6, 0.45, 0.82);
    const flareGain = uniform(1);
    const flare = gaussianBlur(
      lensflare(glow, { threshold: float(0.55), ghostAttenuationFactor: float(22), ghostSpacing: float(0.28) }),
      float(1),
      5,
    );
    this.pipelineNodes = { plain: color, full: color.add(glow).add(flare.mul(flareGain).mul(0.6)), flareGain, bloom: glow };
    this.pipeline.outputNode = this.pipelineNodes.full;
  }

  applySettings(s: Settings) {
    const prev = this.settings ?? s;
    this.settings = { ...s };
    const q = QUALITY[s.quality];
    if (this.renderer) {
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
      this.resize();
    }
    if (this.pipeline && (prev.bloom !== s.bloom || prev.quality !== s.quality || !this.pipeline.outputNode)) {
      this.pipeline.outputNode = s.bloom ? this.pipelineNodes.full : this.pipelineNodes.plain;
      this.pipeline.needsUpdate = true;
    }
    if (this.pipelineNodes) this.pipelineNodes.flareGain.value = q.flare ? 1 : 0;
    for (const belt of this.belts) {
      belt.setDensity(q.belts);
      belt.sprite.visible = s.belts;
    }
    if (this.sky) this.sky.milkyWay.value = s.milkyWay;
    this.labels?.setVisible(s.labels);
    if (s.quality === 'ultra') for (const v of this.views.values()) v.requestHighRes(this.bank);
  }

  private resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.pixelsPerRadian = h / 2 / Math.tan((this.camera.fov * Math.PI) / 360);
  }

  start() {
    this.lastTime = performance.now();
    this.renderer.setAnimationLoop((t: number) => this.frame(t));
  }

  // ─────────────────────────────────────────────────────────── public API

  get(id: string): BodyState | undefined {
    return this.system.get(id);
  }

  select(id: string | null) {
    if (id === this.selectedId) return;
    this.selectedId = id;
    if (id) this.views.get(id)?.requestHighRes(this.bank);
    this.emit('select', id);
  }

  /** Flies the camera to a body and makes it the orbit centre. */
  focus(id: string, opts: { instant?: boolean } = {}) {
    const body = this.system.get(id);
    const view = this.views.get(id);
    if (!body || !view) return;
    this.select(id);
    view.requestHighRes(this.bank);
    const ringed = Boolean(body.def.visual.rings && body.def.visual.rings.opacity > 0.5);
    const distance = body.def.kind === 'star' ? view.extent * 6 : ringed ? view.outerExtent * 2.6 : view.extent * 4.2;
    const sunDir = new THREE.Vector3(-body.pos[0], -body.pos[2], body.pos[1]).normalize();
    const camDir = new THREE.Vector3(
      this.rig.position[0] - body.pos[0],
      this.rig.position[2] - body.pos[2],
      body.pos[1] - this.rig.position[1],
    ).normalize();
    // Arrive at a three-quarter phase: 50° off the Sun line on whichever side the
    // camera already is, raised above the orbit plane — or, for ringed planets,
    // above the sunlit face of the rings so they open up.
    let direction = camDir;
    if (body.def.kind !== 'star') {
      const m = body.rotation;
      const up = ringed ? new THREE.Vector3(m[2], m[8], -m[5]) : new THREE.Vector3(0, 1, 0);
      if (ringed && up.dot(sunDir) < 0) up.negate();
      const side = Math.sign(new THREE.Vector3().crossVectors(sunDir, camDir).dot(up)) || 1;
      direction = sunDir
        .clone()
        .applyAxisAngle(up, side * 0.87)
        .addScaledVector(up, ringed ? 0.5 : 0.3)
        .normalize();
    }
    const duration = this.rig.flyTo(body, { distance, direction, duration: opts.instant ? 1e-3 : undefined });
    this.emit('flight', { to: id, duration });
  }

  setRate(rate: number) {
    this.rate = rate;
  }

  setPaused(paused: boolean) {
    this.paused = paused;
  }

  setJd(jd: number) {
    this.jd = Math.min(JD_MAX, Math.max(JD_MIN, jd));
  }

  now() {
    this.setJd(jdFromDate(new Date()));
  }

  get date() {
    return dateFromJd(this.jd);
  }

  live(id: string): BodyLive | null {
    const b = this.system.get(id);
    if (!b) return null;
    const cam = this.rig.position;
    const parent = b.parent && b.parent.def.kind !== 'star' ? b.parent : null;
    return {
      sunDistanceKm: length(b.pos),
      cameraDistanceKm: Math.hypot(b.pos[0] - cam[0], b.pos[1] - cam[1], b.pos[2] - cam[2]),
      parentDistanceKm: parent ? Math.hypot(b.pos[0] - parent.pos[0], b.pos[1] - parent.pos[1], b.pos[2] - parent.pos[2]) : null,
      speedKms: parent
        ? length([b.vel[0] - parent.vel[0], b.vel[1] - parent.vel[1], b.vel[2] - parent.vel[2]]) / 86400
        : length(b.vel) / 86400,
    };
  }

  // ─────────────────────────────────────────────────────────── input

  private bindInput() {
    const el = this.renderer.domElement;
    const pointers = new Map<number, { x: number; y: number }>();
    let downAt = { x: 0, y: 0, t: 0 };
    let pinch = 0;

    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });
    el.addEventListener('pointermove', (e) => {
      const p = pointers.get(e.pointerId);
      if (!p) {
        if (e.pointerType === 'mouse') this.setHover(this.pick(e.clientX, e.clientY));
        return;
      }
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (pointers.size === 1) {
        this.rig.rotate(dx * 0.0042, dy * 0.0042);
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch > 0) this.rig.zoom(Math.log(pinch / d) * 2.2);
        pinch = d;
      }
    });
    const up = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = 0;
      const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
      if (e.type === 'pointerup' && moved < 6 && performance.now() - downAt.t < 450) {
        const id = this.pick(e.clientX, e.clientY);
        this.select(id);
      }
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('dblclick', (e) => {
      const id = this.pick(e.clientX, e.clientY);
      if (id) this.focus(id);
    });
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const scale = e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 1 : 0.0016;
        this.rig.zoom(Math.max(-0.6, Math.min(0.6, e.deltaY * scale)));
      },
      { passive: false },
    );
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private setHover(id: string | null) {
    if (id === this.hoveredId) return;
    this.hoveredId = id;
    this.renderer.domElement.style.cursor = id ? 'pointer' : '';
    this.emit('hover', id);
  }

  /** Screen-space picking: the nearest body whose disk or marker is under the pointer. */
  pick(clientX: number, clientY: number): string | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best: string | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const [id, s] of this.screen) {
      if (!s.front) continue;
      const d = Math.hypot(s.x - x, s.y - y);
      const hit = Math.max(s.px, 9);
      if (d > hit) continue;
      // Prefer bodies whose disk actually covers the pointer, then the closest one.
      const score = (d <= s.px ? 0 : 1e6) + s.dist;
      if (score < bestScore) {
        bestScore = score;
        best = id;
      }
    }
    return best;
  }

  // ─────────────────────────────────────────────────────────── frame

  private frame(now: number) {
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.frames++;
    this.elapsed += dt;
    this.fpsSmooth += (1 / Math.max(dt, 1e-3) - this.fpsSmooth) * 0.05;
    if (!this.paused) this.setJd(this.jd + (this.rate * dt) / 86400);

    this.system.update(this.jd);
    const focusView = this.views.get(this.rig.focus.def.id)!;
    this.rig.minDistance = focusView.extent * 1.12;
    this.rig.update(dt);
    const cam = this.rig.position;
    this.camera.updateMatrixWorld();

    const s = this.settings;
    const sun = this.system.get('sun')!;
    const v3 = new THREE.Vector3();
    const labels: LabelFrame[] = [];
    this.screen.clear();

    // Place every body relative to the camera and project it.
    for (const [id, view] of this.views) {
      const { dist, px } = view.update(cam, this.elapsed, this.pixelsPerRadian);
      v3.copy(view.group.position).project(this.camera);
      const front = v3.z < 1 && v3.z > -1;
      this.screen.set(id, { x: (v3.x * 0.5 + 0.5) * this.width, y: (-v3.y * 0.5 + 0.5) * this.height, z: v3.z, front, px, dist });
      if (id === this.selectedId || id === this.rig.focus.def.id || px > 140) view.requestHighRes(this.bank);
    }
    const sunView = this.views.get('sun')!;
    SHARED.sunPos.value.copy(sunView.group.position);
    this.light.position.copy(sunView.group.position);
    // Ease the Sun down as its disk fills the view so the photosphere keeps its colour and texture.
    const sunFill = THREE.MathUtils.smoothstep(this.screen.get('sun')?.px ?? 0, 4, 90);
    SHARED.sunGain.value = THREE.MathUtils.lerp(7, 1.35, sunFill);
    SHARED.coronaGain.value = THREE.MathUtils.lerp(1, 0.3, sunFill);
    this.pipelineNodes.bloom.strength.value = THREE.MathUtils.lerp(0.6, 0.18, sunFill);
    // Lens ghosts pivot around the screen centre: a centred Sun would stack them into a ring.
    const sunSc = this.screen.get('sun');
    const offCentre = sunSc?.front ? Math.hypot(sunSc.x - this.width / 2, sunSc.y - this.height / 2) / (this.height / 2) : 1;
    this.pipelineNodes.flareGain.value =
      (QUALITY[s.quality].flare ? 1 : 0) * (1 - 0.85 * sunFill) * THREE.MathUtils.smoothstep(offCentre, 0.06, 0.35);

    // Markers + labels.
    for (const b of this.system.bodies) {
      const id = b.def.id;
      const sc = this.screen.get(id)!;
      const kind = b.def.kind;
      let alpha = Math.min(1, Math.max(0, 1 - (sc.px - 2.5) / 5));
      let sep = Number.POSITIVE_INFINITY;
      if (b.parent && b.parent.def.kind !== 'star') {
        const ps = this.screen.get(b.parent.def.id)!;
        sep = Math.hypot(ps.x - sc.x, ps.y - sc.y);
        alpha *= Math.min(1, Math.max(0, (sep - 4) / 10));
      }
      const occluded = this.occluded(id, sc);
      if (!sc.front || occluded) alpha = 0;
      const selected = id === this.selectedId;
      const color = this.tmpColor.set(b.def.visual.color).multiplyScalar(b.def.visual.glow ?? 1.25);
      const pos = this.views.get(id)!.group.position;
      this.markers.set(b.index, pos.x, pos.y, pos.z, color, MARKER_SIZE[kind] + (selected ? 2 : 0), alpha);

      // No label once a world is a sizeable disk: it is plainly visible and the panel names it.
      if (!sc.front || occluded || sc.px > 36) continue;
      const isFocus = id === this.rig.focus.def.id;
      if (kind === 'moon' && sep < 26 && !selected && !isFocus) continue;
      if ((kind === 'asteroid' || kind === 'comet') && !selected && !isFocus && sc.dist > 12 * AU_KM) continue;
      labels.push({
        id,
        x: sc.x,
        y: sc.y,
        priority: selected || isFocus ? -10 : KIND_PRIORITY[kind] + Math.log10(Math.max(sc.dist, 1)) * 0.5,
        ring: Math.min(60, sc.px + 4),
        opacity: kind === 'planet' || kind === 'star' || selected ? 1 : 0.82,
      });
    }
    this.markers.commit();
    this.labels.setState(this.selectedId, this.hoveredId);
    if (s.labels) this.labels.update(labels);

    // Orbits.
    this.orbits.group.visible = s.orbits;
    if (s.orbits) {
      this.orbits.update({
        cam,
        pixelsPerRadian: this.pixelsPerRadian,
        selectedId: this.selectedId,
        focusId: this.rig.focus.def.id,
        focusPx: this.screen.get(this.rig.focus.def.id)?.px ?? 0,
        showMoons: true,
        opacity: 1,
      });
    }

    // Belts follow the Sun; fade the Oort cloud unless we are far out.
    const camSun = length(cam);
    for (const belt of this.belts) {
      belt.sunRel.value.copy(sunView.group.position);
      belt.days.value = this.jd - J2000;
    }
    this.belts[3].fade.value = Math.min(1, Math.max(0, (Math.log10(camSun / AU_KM) - 2.2) / 1.2));

    // Comet tails point away from the Sun.
    const anti = new THREE.Vector3();
    const vel = new THREE.Vector3();
    for (const [id, tail] of this.tails) {
      const b = this.system.get(id)!;
      const view = this.views.get(id)!;
      tail.group.position.copy(view.group.position);
      anti.set(b.pos[0], b.pos[2], -b.pos[1]).normalize();
      vel.set(b.vel[0], b.vel[2], -b.vel[1]).normalize();
      tail.update(anti, vel, length(b.pos) / AU_KM, b.def.physical.radius);
      if (!s.tails) tail.group.visible = false;
    }

    this.pipeline.render();

    this.telemetryClock += dt;
    if (this.telemetryClock > 0.1) {
      this.telemetryClock = 0;
      this.emit('frame', {
        jd: this.jd,
        rate: this.rate,
        paused: this.paused,
        focusId: this.rig.focus.def.id,
        selectedId: this.selectedId,
        flying: this.rig.flying,
        focusDistance: Math.hypot(...([0, 1, 2].map((k) => cam[k] - this.rig.focus.pos[k]) as Vec3)),
        sunDistance: Math.hypot(cam[0] - sun.pos[0], cam[1] - sun.pos[1], cam[2] - sun.pos[2]),
        fps: this.fpsSmooth,
      });
    }
  }

  /** True when a nearer body's disk covers this body's centre on screen. */
  private occluded(id: string, sc: { x: number; y: number; dist: number }) {
    for (const [other, o] of this.screen) {
      if (other === id || o.px < 3 || !o.front || o.dist >= sc.dist) continue;
      if (Math.hypot(o.x - sc.x, o.y - sc.y) < o.px * 0.92) return true;
    }
    return false;
  }
}
