import * as THREE from 'three/webgpu';

const BASE = `${import.meta.env.BASE_URL}textures/`;
/** Data maps that must stay linear (everything else is sRGB color). */
const LINEAR = new Set(['earth-normal', 'earth-specular', 'earth-clouds']);

interface Entry {
  lo: THREE.Texture;
  hi: THREE.Texture | null;
  hiPromise: Promise<THREE.Texture> | null;
  listeners: Array<(t: THREE.Texture) => void>;
}

/**
 * Two-tier texture streaming: every map has a 1024 px `.lo` variant loaded at
 * startup and a full-resolution variant fetched on demand when the camera
 * approaches (or the player selects) a body.
 */
export class TextureBank {
  private readonly loader = new THREE.TextureLoader();
  private readonly entries = new Map<string, Entry>();
  private anisotropy = 8;

  constructor(private readonly onProgress?: (loaded: number, total: number) => void) {}

  setAnisotropy(a: number) {
    this.anisotropy = a;
  }

  private configure(id: string, t: THREE.Texture) {
    t.colorSpace = LINEAR.has(id) ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    t.wrapS = id === 'saturn-ring' ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.anisotropy = this.anisotropy;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    return t;
  }

  /** Preloads the low-resolution tier for a list of texture ids. */
  async preload(ids: string[]) {
    let loaded = 0;
    this.onProgress?.(0, ids.length);
    await Promise.all(
      ids.map(async (id) => {
        const lo = this.configure(id, await this.loader.loadAsync(`${BASE}${id}.lo.webp`));
        this.entries.set(id, { lo, hi: null, hiPromise: null, listeners: [] });
        this.onProgress?.(++loaded, ids.length);
      }),
    );
  }

  /** The best texture currently available. */
  get(id: string): THREE.Texture {
    const e = this.entries.get(id);
    if (!e) throw new Error(`texture ${id} was not preloaded`);
    return e.hi ?? e.lo;
  }

  has(id: string) {
    return this.entries.has(id);
  }

  /** Registers a callback fired when the high-resolution tier arrives. */
  onUpgrade(id: string, fn: (t: THREE.Texture) => void) {
    const e = this.entries.get(id);
    if (!e) return;
    if (e.hi) fn(e.hi);
    else e.listeners.push(fn);
  }

  /** Starts streaming the high-resolution tier (idempotent). */
  upgrade(id: string): Promise<THREE.Texture> | null {
    const e = this.entries.get(id);
    if (!e) return null;
    if (!e.hiPromise) {
      e.hiPromise = this.loader.loadAsync(`${BASE}${id}.webp`).then((t) => {
        e.hi = this.configure(id, t);
        for (const fn of e.listeners) fn(e.hi);
        e.listeners.length = 0;
        e.lo.dispose();
        return e.hi;
      });
    }
    return e.hiPromise;
  }

  isHigh(id: string) {
    return Boolean(this.entries.get(id)?.hi);
  }
}
