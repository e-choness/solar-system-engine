import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import * as THREE from 'three/webgpu';
import ktx2Textures from '../data/generated/ktx2-textures.json' with { type: 'json' };
import midTextures from '../data/generated/mid-textures.json' with { type: 'json' };

const BASE = `${import.meta.env.BASE_URL}textures/`;
/** Data maps that must stay linear (everything else is sRGB color); `linear` in scripts/fetch-assets.mjs. */
const LINEAR = new Set(['earth-normal', 'earth-specular', 'earth-clouds']);
/** Maps with a 2048 px WebP tier; every other map is that size or smaller already. */
const MID = new Set<string>(midTextures);
/** Maps with GPU-compressed copies of a tier (see writeKtx2 in scripts/fetch-assets.mjs). */
const KTX2 = { lo: new Set<string>(ktx2Textures.lo), mid: new Set<string>(ktx2Textures.mid) };

type Tier = 'lo' | 'mid' | 'hi';
interface Loader {
  loadAsync(url: string): Promise<THREE.Texture>;
}
/** A map used this recently is on screen, however far over budget the bank is. */
const IN_USE_MS = 5000;

interface Entry {
  lo: THREE.Texture;
  hi: THREE.Texture | null;
  hiPromise: Promise<THREE.Texture> | null;
  listeners: Array<(t: THREE.Texture) => void>;
  /** Last time something asked for the high tier (ms). */
  used: number;
}

/** How much of the high tier a device can hold. Without a budget, everything streams at full size. */
export interface TextureBudget {
  /** Stream the 2048 px tier in place of full-resolution maps. */
  mid: boolean;
  /** Most high-tier maps kept at once; the least recently used fall back to `.lo`. */
  keep: number;
}

/**
 * Two-tier texture streaming: every map has a 1024 px `.lo` variant loaded at
 * startup and a full-resolution variant fetched on demand when the camera
 * approaches (or the player selects) a body. A budget caps that second tier on
 * devices that could not hold it all.
 *
 * Once `useCompressed` is called, the `.lo` and `.mid` tiers load as KTX2, which
 * stays compressed in GPU memory. A failed KTX2 load falls back to WebP for the
 * rest of the session.
 */
export class TextureBank {
  private readonly loader: Loader = new THREE.TextureLoader();
  private ktx2: Loader | null = null;
  private readonly entries = new Map<string, Entry>();
  private anisotropy = 8;

  constructor(
    private readonly onProgress?: (loaded: number, total: number) => void,
    private readonly budget?: TextureBudget,
  ) {}

  /** True when high-tier maps can be dropped, so callers must keep asking for the ones they use. */
  get evicts() {
    return Boolean(this.budget);
  }

  setAnisotropy(a: number) {
    this.anisotropy = a;
  }

  /**
   * Loads KTX2 tiers from here on, transcoded in workers to whatever block format
   * the GPU samples (ASTC, BC7, ETC2…). Call after `renderer.init()`.
   */
  useCompressed(renderer: THREE.WebGPURenderer) {
    this.ktx2 = new KTX2Loader().setTranscoderPath(`${import.meta.env.BASE_URL}basis/`).detectSupport(renderer);
  }

  /** True while maps load as KTX2. */
  get compressed() {
    return this.ktx2 !== null;
  }

  private configure(id: string, t: THREE.Texture) {
    t.colorSpace = LINEAR.has(id) ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    t.wrapS = id === 'saturn-ring' ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.anisotropy = this.anisotropy;
    // KTX2 files carry their own mip chain; the GPU can't build one for block-compressed data.
    t.generateMipmaps = !(t as THREE.CompressedTexture).isCompressedTexture;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    return t;
  }

  /** Loads one tier of a map: its KTX2 copy if there is one, otherwise (or if that fails) the WebP. */
  private async load(id: string, tier: Tier): Promise<THREE.Texture> {
    const ktx2 = this.ktx2;
    if (ktx2 && tier !== 'hi' && KTX2[tier].has(id)) {
      try {
        return await ktx2.loadAsync(`${BASE}${id}.${tier}.ktx2`);
      } catch (err) {
        // Most likely no WebAssembly or no workers, so every other KTX2 load would fail too.
        if (this.ktx2) console.warn(`texture ${id}: KTX2 failed to load, using WebP from now on`, err);
        this.ktx2 = null;
      }
    }
    const file = tier === 'lo' ? `${id}.lo` : tier === 'mid' && MID.has(id) ? `${id}.mid` : id;
    return this.loader.loadAsync(`${BASE}${file}.webp`);
  }

  /** The tier to stream up close: phones take at most 2048 px, as KTX2 if they can. */
  private closeTier(id: string): Tier {
    if (!this.budget?.mid) return 'hi';
    return MID.has(id) || (this.ktx2 && KTX2.mid.has(id)) ? 'mid' : 'hi';
  }

  /** Preloads the low-resolution tier for a list of texture ids. */
  async preload(ids: string[]) {
    let loaded = 0;
    this.onProgress?.(0, ids.length);
    await Promise.all(
      ids.map(async (id) => {
        const lo = this.configure(id, await this.load(id, 'lo'));
        this.entries.set(id, { lo, hi: null, hiPromise: null, listeners: [], used: 0 });
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

  /** Registers a callback fired when the high-resolution tier arrives (or, under a budget, is dropped). */
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
    e.used = performance.now();
    if (!e.hiPromise) {
      e.hiPromise = this.load(id, this.closeTier(id))
        .then((t) => {
          e.hi = this.configure(id, t);
          for (const fn of e.listeners) fn(e.hi);
          if (this.budget) {
            this.evict(this.budget.keep);
          } else {
            e.listeners.length = 0;
            e.lo.dispose();
          }
          return t;
        })
        .catch((err) => {
          // Keep showing the low tier; the next upgrade() call retries.
          console.warn(`texture ${id}: high-resolution tier failed to load`, err);
          e.hiPromise = null;
          return e.lo;
        });
    }
    return e.hiPromise;
  }

  /** Returns the least recently used high-tier maps to `.lo`, keeping anything in use. */
  private evict(keep: number) {
    const high = [...this.entries.values()].filter((e) => e.hi).sort((a, b) => a.used - b.used);
    const now = performance.now();
    for (const e of high.slice(0, Math.max(0, high.length - keep))) {
      if (now - e.used < IN_USE_MS) break;
      for (const fn of e.listeners) fn(e.lo);
      e.hi?.dispose();
      e.hi = null;
      e.hiPromise = null;
    }
  }

  isHigh(id: string) {
    return Boolean(this.entries.get(id)?.hi);
  }
}
