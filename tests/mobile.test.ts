import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { isMobileDevice } from '../src/engine/device.ts';
import { ResolutionGovernor } from '../src/engine/governor.ts';
import { TextureBank } from '../src/engine/textures.ts';

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
