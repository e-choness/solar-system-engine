import * as THREE from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import { graphicsAdvice, isAppleMobile, isMobileDevice, preferredBackend, requestedBackend } from '../src/engine/device.ts';
import { ResolutionGovernor } from '../src/engine/governor.ts';
import { TextureBank, type TextureBudget } from '../src/engine/textures.ts';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
const PIXEL = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36';
const ANDROID_TABLET = 'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';

describe('isMobileDevice', () => {
  const device = (userAgent: string, platform = 'Linux', maxTouchPoints = 0) => isMobileDevice({ userAgent, platform, maxTouchPoints });

  it('recognises phones and tablets', () => {
    expect(device(IPHONE, 'iPhone', 5)).toBe(true);
    expect(device(PIXEL, 'Linux armv8l', 5)).toBe(true);
    expect(device(ANDROID_TABLET, 'Linux armv8l', 10)).toBe(true);
    expect(isMobileDevice({ userAgent: WINDOWS, platform: 'Linux', maxTouchPoints: 5, uaMobile: true })).toBe(true);
  });

  it('sees through iPadOS reporting itself as a Mac', () => {
    expect(device(MAC, 'MacIntel', 5)).toBe(true);
  });

  it('leaves desktops alone, touch laptops included', () => {
    expect(device(MAC, 'MacIntel', 0)).toBe(false);
    expect(device(WINDOWS, 'Win32', 0)).toBe(false);
    expect(device(WINDOWS, 'Win32', 10)).toBe(false);
  });
});

describe('backend choice', () => {
  const apple = (userAgent: string, platform = 'Linux', maxTouchPoints = 0) => isAppleMobile({ userAgent, platform, maxTouchPoints });

  it('knows iPhones and iPads, but not Android or Macs', () => {
    expect(apple(IPHONE, 'iPhone', 5)).toBe(true);
    expect(apple(MAC, 'MacIntel', 5)).toBe(true);
    expect(apple(MAC, 'MacIntel', 0)).toBe(false);
    expect(apple(PIXEL, 'Linux armv8l', 5)).toBe(false);
  });

  it('starts iPhones and iPads on WebGL 2 and everything else on WebGPU', () => {
    expect(preferredBackend({ appleMobile: true, forced: false, requested: null })).toBe('webgl');
    expect(preferredBackend({ appleMobile: false, forced: false, requested: null })).toBe('webgpu');
    expect(preferredBackend({ appleMobile: false, forced: true, requested: null })).toBe('webgl');
  });

  it('lets the URL override the choice', () => {
    expect(requestedBackend('?backend=webgpu')).toBe('webgpu');
    expect(requestedBackend('?x=1&backend=WebGL')).toBe('webgl');
    expect(requestedBackend('?backend=vulkan')).toBeNull();
    expect(requestedBackend('')).toBeNull();
    expect(preferredBackend({ appleMobile: true, forced: true, requested: 'webgpu' })).toBe('webgpu');
  });

  it('explains a browser with graphics turned off', () => {
    const off = { webgpu: false, webgl2: false, webgl: false };
    expect(graphicsAdvice(off, true).advice).toMatch(/Lockdown Mode/);
    expect(graphicsAdvice(off, false).advice).toMatch(/hardware acceleration/);
    expect(graphicsAdvice({ webgpu: false, webgl2: false, webgl: true }, false).title).toMatch(/too old/);
    expect(graphicsAdvice({ webgpu: false, webgl2: true, webgl: true }, true).title).toMatch(/driver/);
  });
});

describe('ResolutionGovernor', () => {
  /** Feeds whole measurement windows of a constant frame time; returns the last change. */
  const run = (g: ResolutionGovernor, ms: number, windows: number) => {
    let last: number | null = null;
    for (let i = 0; i < windows * 45; i++) last = g.sample(ms) ?? last;
    return last;
  };

  it('holds full resolution while the frame rate is fine', () => {
    const g = new ResolutionGovernor();
    expect(run(g, 16.7, 20)).toBeNull();
    expect(g.scale).toBe(1);
  });

  it('leaves a steady 30 fps alone', () => {
    const g = new ResolutionGovernor();
    run(g, 33.3, 20);
    expect(g.scale).toBe(1);
  });

  it('steps down under load, no further than the floor', () => {
    const g = new ResolutionGovernor(0.6);
    run(g, 60, 1);
    expect(g.scale).toBeCloseTo(0.85);
    run(g, 60, 40);
    expect(g.scale).toBe(0.6);
  });

  it('ignores one-off stalls such as shader compiles', () => {
    const g = new ResolutionGovernor();
    for (let i = 0; i < 450; i++) g.sample(i % 45 === 0 ? 900 : 16.7);
    expect(g.scale).toBe(1);
  });

  it('recovers once the load eases', () => {
    const g = new ResolutionGovernor();
    run(g, 60, 3);
    expect(g.scale).toBeLessThan(1);
    run(g, 16.7, 60);
    expect(g.scale).toBe(1);
  });

  it('backs off when raising the resolution brings the slowdown straight back', () => {
    const g = new ResolutionGovernor();
    run(g, 60, 1);
    run(g, 16.7, 4); // Raised after the first patience of 4 windows.
    expect(g.scale).toBeCloseTo(0.952);
    run(g, 60, 1); // That was too much: it steps down and doubles the wait.
    run(g, 16.7, 7);
    expect(g.scale).toBeLessThan(0.82);
    run(g, 16.7, 1);
    expect(g.scale).toBeCloseTo(0.9063, 3);
  });
});

describe('TextureBank under a budget', () => {
  function bank(keep: number, mid = true) {
    const urls: string[] = [];
    const b = new TextureBank(undefined, { mid, keep });
    // No network or image decoding here: hand back blank textures and record what was asked for.
    Object.assign(b as any, {
      loader: {
        loadAsync: async (url: string) => {
          urls.push(url);
          return new THREE.Texture();
        },
      },
    });
    return { b, urls };
  }

  it('streams the 2048 px tier only for maps that have one', async () => {
    const { b, urls } = bank(4);
    await b.preload(['earth', 'uranus']);
    await Promise.all([b.upgrade('earth'), b.upgrade('uranus')]);
    expect(urls).toContain(`${import.meta.env.BASE_URL}textures/earth.mid.webp`);
    expect(urls).toContain(`${import.meta.env.BASE_URL}textures/uranus.webp`);
  });

  it('drops the least recently used map and swaps its low tier back in', async () => {
    const { b } = bank(2);
    await b.preload(['moon', 'mars', 'io']);
    const swaps: string[] = [];
    b.onUpgrade('moon', (t) => swaps.push(t === b.get('moon') ? 'hi' : 'lo'));
    await b.upgrade('moon');
    await b.upgrade('mars');
    // Age the first two past the in-use window, then go over budget.
    (b as any).entries.get('moon').used -= 60_000;
    (b as any).entries.get('mars').used -= 30_000;
    await b.upgrade('io');
    expect(b.isHigh('moon')).toBe(false);
    expect(b.isHigh('mars')).toBe(true);
    expect(b.isHigh('io')).toBe(true);
    expect(swaps.length).toBe(2);
    // A dropped map streams again when the camera comes back.
    await b.upgrade('moon');
    expect(b.isHigh('moon')).toBe(true);
  });

  it('never drops a map that is on screen, however far over budget', async () => {
    const { b } = bank(1);
    await b.preload(['earth', 'earth-night', 'earth-normal']);
    await Promise.all([b.upgrade('earth'), b.upgrade('earth-night'), b.upgrade('earth-normal')]);
    expect(['earth', 'earth-night', 'earth-normal'].every((id) => b.isHigh(id))).toBe(true);
  });

  it('keeps every map forever without a budget', async () => {
    const b = new TextureBank();
    Object.assign(b as any, { loader: { loadAsync: async () => new THREE.Texture() } });
    await b.preload(['moon']);
    await b.upgrade('moon');
    expect(b.evicts).toBe(false);
    expect(b.isHigh('moon')).toBe(true);
  });
});

describe('TextureBank with KTX2', () => {
  function bank(budget?: TextureBudget, ktx2Fails = false) {
    const files: string[] = [];
    const b = new TextureBank(undefined, budget);
    const fake = (compressed: boolean) => ({
      loadAsync: async (url: string) => {
        files.push(url.split('/').pop()!);
        if (compressed && ktx2Fails) throw new Error('WebAssembly is unavailable');
        return compressed ? new THREE.CompressedTexture([], 4, 4) : new THREE.Texture();
      },
    });
    Object.assign(b as any, { loader: fake(false), ktx2: fake(true) });
    return { b, files };
  }

  it('preloads the compressed far tier and streams the compressed phone tier', async () => {
    const { b, files } = bank({ mid: true, keep: 4 });
    await b.preload(['earth', 'uranus']);
    await Promise.all([b.upgrade('earth'), b.upgrade('uranus')]);
    // Uranus has no 2048 px WebP (its full map is that size), but it has a compressed one.
    expect(files.sort()).toEqual(['earth.lo.ktx2', 'earth.mid.ktx2', 'uranus.lo.ktx2', 'uranus.mid.ktx2']);
    // The GPU can't build mipmaps for block-compressed data; the file brings its own.
    expect(b.get('earth').generateMipmaps).toBe(false);
  });

  it('keeps the full-resolution WebP for close-ups on desktop', async () => {
    const { b, files } = bank();
    await b.preload(['earth']);
    await b.upgrade('earth');
    expect(files).toEqual(['earth.lo.ktx2', 'earth.webp']);
    expect(b.get('earth').generateMipmaps).toBe(true);
  });

  it('falls back to WebP for the rest of the session when KTX2 fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { b, files } = bank({ mid: true, keep: 4 }, true);
    await b.preload(['earth', 'uranus']);
    expect(b.compressed).toBe(false);
    await Promise.all([b.upgrade('earth'), b.upgrade('uranus')]);
    expect(files.filter((f) => f.endsWith('.webp')).sort()).toEqual(['earth.lo.webp', 'earth.mid.webp', 'uranus.lo.webp', 'uranus.webp']);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
