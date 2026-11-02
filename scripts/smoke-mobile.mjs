// Mobile smoke test: boots the dev server under phone and tablet emulation, drives it
// with real touch input and checks the layout, gestures, asset tier and recovery paths.
// Screenshots land in .cache/smoke-mobile. Exits non-zero if any check fails.
//
// Run in Docker: docker compose up -d dev && docker compose run --rm browser npm run smoke:mobile [webgl|webgpu] [device…]
import fs from 'node:fs';
import path from 'node:path';
import { chromium, devices } from 'playwright';

const URL = process.env.APP_URL ?? 'http://localhost:5173';
const OUT = path.resolve('.cache/smoke-mobile');
const args = process.argv.slice(2);
const backend = args.includes('webgpu') ? 'webgpu' : 'webgl';
const only = args.filter((a) => a !== 'webgl' && a !== 'webgpu');
fs.mkdirSync(OUT, { recursive: true });

const iphone = devices['iPhone 14'];
const pixel = devices['Pixel 7'];
const ipad = devices['iPad Mini'];
const profile = (base, width, height, extra = {}) => ({ ...base, viewport: { width, height }, screen: { width, height }, ...extra });
const DEVICES = {
  'iphone-portrait': profile(iphone, 390, 844),
  'iphone-landscape': profile(iphone, 844, 390),
  'android-portrait': profile(pixel, 360, 780),
  'small-phone': profile(iphone, 320, 568, { deviceScaleFactor: 2 }),
  tablet: profile(ipad, 820, 1180),
};

const browser = await chromium.launch({
  args:
    backend === 'webgpu'
      ? ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist']
      : ['--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl'],
  env: { ...process.env, EGL_PLATFORM: 'surfaceless' },
});

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
};

async function run(name, device) {
  console.log(`\n${name}: ${device.viewport.width}x${device.viewport.height} @${device.deviceScaleFactor}x, ${backend}`);
  const { defaultBrowserType: _, ...options } = device;
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('request', (r) => requests.push(r.url()));
  const cdp = await context.newCDPSession(page);

  const shot = (label) => page.screenshot({ path: path.join(OUT, `${name}-${label}.png`) });
  const wait = (ms) => page.waitForTimeout(ms);
  const solar = (fn, arg) => page.evaluate(fn, arg);
  const settled = () => page.waitForFunction(() => !window.__solar.engine.rig.flying, null, { timeout: 60_000 });

  // Real touch input, so the browser's own gesture handling takes part.
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
  const tap = async (x, y) => {
    await touch('touchStart', [[x, y]]);
    await touch('touchEnd', []);
  };
  const drag = async (from, to, steps = 8) => {
    await touch('touchStart', [from]);
    for (let i = 1; i <= steps; i++)
      await touch('touchMove', [[from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps]]);
    await touch('touchEnd', []);
  };
  const pinch = async (c, start, end, steps = 8) => {
    await touch('touchStart', [[c[0] - start, c[1]]]);
    await touch('touchStart', [
      [c[0] - start, c[1]],
      [c[0] + start, c[1]],
    ]);
    for (let i = 1; i <= steps; i++) {
      const d = start + ((end - start) * i) / steps;
      await touch('touchMove', [
        [c[0] - d, c[1]],
        [c[0] + d, c[1]],
      ]);
    }
    await touch('touchEnd', []);
  };
  /** Where a body is on screen right now. */
  const screenOf = (id) => solar((id) => window.__solar.engine.screen.get(id), id);

  /** Checks that the open interface fits the screen and nothing covers anything else. */
  const fits = (label) =>
    solar(() => {
      const vw = innerWidth;
      const vh = innerHeight;
      const rect = (el) => el.getBoundingClientRect();
      const visible = (el) => rect(el).width > 0 && getComputedStyle(el).visibility !== 'hidden';
      const name = (el) => String(el.className.baseVal ?? el.className).split(' ')[0] || el.tagName;
      const offscreen = [...document.querySelectorAll('.glass, .glass button, .glass a, .glass input')]
        .filter(visible)
        .filter((el) => !el.closest('.scroll'))
        .filter((el) => {
          const r = rect(el);
          return r.right > vw + 1 || r.left < -1 || r.bottom > vh + 1 || r.top < -1;
        })
        .map(name);
      const panels = [...document.querySelectorAll('.bar .left, .bar .right, .timebar, .sheet')].filter(visible);
      const overlaps = [];
      for (let i = 0; i < panels.length; i++)
        for (let k = i + 1; k < panels.length; k++) {
          const [a, b] = [rect(panels[i]), rect(panels[k])];
          if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1)
            overlaps.push(`${name(panels[i])}/${name(panels[k])}`);
        }
      // The date's tap target is enlarged by a pseudo-element, which getBoundingClientRect can't see.
      const tiny = [...document.querySelectorAll('.bar button, .timebar button:not(.date), .sheet .actions button, .sheet .actions a')]
        .filter(visible)
        .filter((el) => rect(el).height < 40 || rect(el).width < 34)
        .map((el) => `${name(el)} ${rect(el).width | 0}x${rect(el).height | 0}`);
      return { offscreen, overlaps, tiny };
    }).then((r) => {
      check(`${label}: nothing off screen`, r.offscreen.length === 0, r.offscreen.join(', '));
      check(`${label}: panels don't overlap`, r.overlaps.length === 0, r.overlaps.join(', '));
      check(`${label}: touch targets large enough`, r.tiny.length === 0, r.tiny.join(', '));
    });

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => ['title', 'error'].includes(window.__solar?.app.stage), null, { timeout: 180_000 });
  const stage = await solar(() => [window.__solar.app.stage, window.__solar.app.error, window.__solar.engine.backend]);
  check('boots to the title screen', stage[0] === 'title', `${stage[2]}${stage[1] ? ` ${stage[1]}` : ''}`);
  if (stage[0] !== 'title') {
    await shot('failure');
    await context.close();
    return;
  }
  await wait(800);
  await shot('1-title');
  const budget = await solar(() => ({
    quality: window.__solar.app.settings.quality,
    evicts: window.__solar.engine.bank.evicts,
    ratio: window.__solar.engine.renderer.getPixelRatio(),
    toasts: window.__solar.app.toasts.length,
  }));
  check('uses the mobile budget', budget.quality === 'medium' && budget.evicts, JSON.stringify(budget));
  check('no WebGL notice over the title', budget.toasts === 0);

  await page.getByRole('button', { name: /begin the journey/i }).tap();
  await page.waitForFunction(() => window.__solar.app.stage === 'explore', null, { timeout: 30_000 });
  await page.waitForFunction(() => window.__solar.app.selectedId === 'earth', null, { timeout: 30_000 });
  await settled();
  await wait(1800);
  await shot('2-earth');
  await fits('details card');

  // Framing: the whole world fits across the screen, even in portrait.
  const w = device.viewport.width;
  const h = device.viewport.height;
  const earth = await screenOf('earth');
  check('Earth fits the screen', earth.px * 2 < Math.min(w, h), `disk ${Math.round(earth.px * 2)}px`);

  // ── gestures
  const pose = () =>
    solar(() => ({ yaw: window.__solar.engine.rig.yaw, pitch: window.__solar.engine.rig.pitch, d: window.__solar.engine.rig.distance }));
  const free = [w / 2, Math.min(h * 0.3, 140)];
  let before = await pose();
  await drag([w * 0.3, free[1]], [w * 0.75, free[1] + 30]);
  await wait(900);
  let after = await pose();
  check('drag orbits the camera', Math.abs(after.yaw - before.yaw) > 0.1, `Δyaw ${(after.yaw - before.yaw).toFixed(2)}`);

  before = after;
  await pinch([w / 2, h * 0.45], 40, 110);
  await wait(900);
  after = await pose();
  check('pinch out zooms in', after.d < before.d * 0.7, `${(before.d / after.d).toFixed(2)}×`);
  check('pinch does not reselect', (await solar(() => window.__solar.app.selectedId)) === 'earth');
  before = after;
  await pinch([w / 2, h * 0.45], 110, 40);
  await wait(900);
  after = await pose();
  check('pinch in zooms out', after.d > before.d * 1.4, `${(after.d / before.d).toFixed(2)}×`);

  // Selecting: a tap on empty space clears, a tap beside a marker still hits it.
  await solar(() => window.__solar.engine.focus('sun', { instant: true }));
  await settled();
  await solar(() => {
    const { engine } = window.__solar;
    engine.rig.jumpTo(engine.get('sun'), 5 * 149597870.7);
    engine.select(null);
  });
  await wait(500);
  const sun = await screenOf('sun');
  await tap(sun.x + 14, sun.y + 10);
  await wait(400);
  check('a tap near a marker selects it', (await solar(() => window.__solar.app.selectedId)) === 'sun');
  await solar(() => window.__solar.engine.select(null));

  const jupiter = await solar(() => {
    const { engine } = window.__solar;
    return engine.screen.get('jupiter');
  });
  if (jupiter.front && jupiter.x > 20 && jupiter.x < w - 20 && jupiter.y > 90 && jupiter.y < h - 90) {
    await tap(jupiter.x, jupiter.y);
    await wait(120);
    await tap(jupiter.x, jupiter.y);
    await wait(500);
    const flown = await solar(() => ({ selected: window.__solar.app.selectedId, flying: window.__solar.engine.rig.flying }));
    check('double-tap flies to a world', flown.selected === 'jupiter' && flown.flying, JSON.stringify(flown));
  } else {
    await solar(() => window.__solar.engine.focus('jupiter', { instant: true }));
  }
  await settled();
  await wait(1500);
  await shot('3-jupiter');

  // ── sheets
  const button = (label) => page.getByRole('button', { name: label, exact: true });
  await button('Toggle body browser').tap();
  await wait(500);
  await fits('body browser');
  await shot('4-browser');
  check(
    'browser replaces the details card',
    (await solar(() => document.querySelectorAll('.info').length)) === 0 || !name.includes('portrait'),
  );
  await page.locator('.browser .item', { hasText: 'Saturn' }).tap();
  await wait(400);
  check('picking a world closes the browser', (await solar(() => window.__solar.app.browserOpen)) === false);
  await settled();
  await wait(1800);
  await shot('5-saturn');
  const saturn = await solar(() => window.__solar.engine.views.get('saturn').outerExtent / window.__solar.engine.rig.distance);
  const ringPx = saturn * (await solar(() => window.__solar.engine.pixelsPerRadian)) * 2;
  check('Saturn’s rings fit the screen', ringPx < Math.min(w, h) * 1.02, `${Math.round(ringPx)}px`);

  // Expanding the details by swiping the handle, then swiping back.
  if (name !== 'iphone-landscape') {
    const grab = await page.locator('.info .grab').boundingBox();
    if (grab) {
      await drag([grab.x + grab.width / 2, grab.y + 10], [grab.x + grab.width / 2, grab.y - 110]);
      await wait(500);
      check('swipe up expands the details', await solar(() => Boolean(document.querySelector('.info.expanded .body'))));
      await shot('6-expanded');
      await fits('expanded details');
      const open = await page.locator('.info .grab').boundingBox();
      await drag([open.x + open.width / 2, open.y + 10], [open.x + open.width / 2, open.y + 140]);
      await wait(500);
      check('swipe down collapses them', await solar(() => !document.querySelector('.info.expanded')));
    }
  } else {
    await button('Show more').last().tap();
    await wait(500);
    await shot('6-expanded');
    await fits('expanded details');
    await button('Show less').last().tap();
  }

  if (await solar(() => window.__solar.app.compact)) {
    const menu = async (item) => {
      await button('Menu').tap();
      await wait(350);
      await page.getByRole('menuitem', { name: item }).tap();
      await wait(600);
    };
    await button('Menu').tap();
    await wait(350);
    await shot('7-menu');
    await page.locator('.scrim').tap({ position: { x: 20, y: h / 2 } });
    await wait(300);
    await menu('Settings');
    await fits('settings');
    await shot('8-settings');
    await button('Close settings').tap();
    await menu('Time travel');
    await fits('time travel');
    await shot('9-events');
    await tap(w / 2, 76); // Just below the top bar: sheets always leave this band of scene free.
    await wait(500);
    check('tapping the scene closes a sheet', (await solar(() => window.__solar.app.eventsOpen)) === false);
    await menu('Controls');
    await shot('10-help');
    await button('Close').last().tap();
    await wait(300);
    await menu('About & credits');
    await shot('11-credits');
    await button('Close').last().tap();
    await wait(300);

    await button('More time controls').tap();
    await wait(400);
    await fits('time controls');
    await shot('12-timebar');
    await button('More time controls').tap();
    await wait(300);
  }

  // Search with the on-screen keyboard's input path.
  await page.locator('#search').tap();
  await page.locator('#search').fill('tita');
  await wait(300);
  await shot('13-search');
  await page.locator('.results button', { hasText: 'Titan' }).first().tap();
  await wait(500);
  check('search result flies there', (await solar(() => window.__solar.app.selectedId)) === 'titan');
  await settled();

  // ── budget
  await solar(() => window.__solar.engine.focus('earth', { instant: true }));
  await settled();
  await wait(2000);
  const urls = requests.filter((u) => u.includes('/textures/')).map((u) => u.split('/').pop().split('?')[0]);
  const fullSize = urls.filter((u) => !/\.(lo|mid)\.webp$/.test(u));
  const hasMid = new Set(urls.filter((u) => u.endsWith('.mid.webp')).map((u) => u.replace('.mid', '')));
  check(
    'streams the phone tier',
    urls.some((u) => u === 'earth.mid.webp'),
    `${urls.filter((u) => u.includes('.mid.')).length} mid maps`,
  );
  check(
    'no 4K map downloaded',
    !fullSize.some((u) => hasMid.has(u)) && !fullSize.some((u) => /^(earth|moon|jupiter|saturn)\.webp$/.test(u)),
    fullSize.join(' '),
  );
  const state = await solar(() => ({ ratio: window.__solar.engine.renderer.getPixelRatio(), fps: window.__solar.app.telemetry?.fps }));
  console.log(`  ..   pixel ratio ${state.ratio.toFixed(2)}, ${state.fps?.toFixed(0)} fps on software rendering`);

  // ── lifecycle
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await wait(300);
  check('audio stops in the background', (await solar(() => window.__solar.audio.ctx?.state)) !== 'running');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await wait(300);
  check('audio resumes on return', (await solar(() => window.__solar.audio.ctx?.state)) === 'running');

  if (backend === 'webgl') {
    await solar(() => document.querySelector('canvas.viewport').getContext('webgl2').getExtension('WEBGL_lose_context').loseContext());
    await wait(800);
    check('a lost GPU context offers a reload', await page.getByRole('button', { name: 'Reload' }).isVisible());
    await shot('14-lost');
  }

  const unexpected = errors.filter((e) => !/GPU context lost|Context Lost|context lost/i.test(e));
  check('no console errors', unexpected.length === 0, unexpected.slice(0, 3).join(' | ').slice(0, 400));
  await context.close();
}

try {
  for (const [name, device] of Object.entries(DEVICES)) if (!only.length || only.includes(name)) await run(name, device);
} catch (err) {
  failed++;
  console.error('smoke failed:', err.message);
} finally {
  await browser.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
