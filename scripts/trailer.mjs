// Records the feature trailer, media/trailer.mp4: a scripted, captioned tour of
// the live app set to the original soundtrack.
//
// The page runs on Playwright's fake clock. Every video frame advances game
// time by a fixed step and is then captured, so the slow software renderer in
// Docker still yields a smooth 30 fps video. CSS transitions and Svelte's Web
// Animations are stepped on the same timeline.
//
// Two steps, because Chromium lives in the browser image and ffmpeg in the node image:
//   docker compose up -d dev
//   docker compose run --rm browser npm run trailer         # capture frames to .cache/trailer
//   docker compose run --rm node npm run trailer:encode     # mux → media/trailer.mp4
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const FPS = 30;
/** Game time per video frame (ms). The fake clock fires rAF every 16 ms, so this is two engine frames. */
const STEP_MS = 32;
const W = 1920;
const H = 1080;
const WORK = path.resolve('.cache/trailer');
const FRAMES = path.join(WORK, 'frames');
const OUT = path.resolve('media/trailer.mp4');
const POSTER = path.resolve('media/trailer-poster.jpg');
const MUSIC = path.resolve('public/audio/original/soundtrack.m4a');

if (process.argv.includes('--encode')) encode();
else await capture();

// ─────────────────────────────────────────────────────────── encode

function encode() {
  const meta = JSON.parse(fs.readFileSync(path.join(WORK, 'meta.json'), 'utf8'));
  const dur = meta.frames / FPS;
  const ffmpeg = (args) => {
    const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-stats', ...args], { stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status ?? 1);
  };
  ffmpeg(
    [
      ['-framerate', FPS, '-i', path.join(FRAMES, '%05d.jpg')],
      ['-i', MUSIC],
      [
        '-filter_complex',
        `[0:v]fade=t=in:d=0.8,fade=t=out:st=${(dur - 1.2).toFixed(2)}:d=1.2,format=yuv420p[v];` +
          `[1:a]atrim=0:${dur.toFixed(2)},asetpts=PTS-STARTPTS,loudnorm=I=-16:TP=-1.5:LRA=11,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,afade=t=in:d=1,afade=t=out:st=${(dur - 4).toFixed(2)}:d=4[a]`,
      ],
      ['-map', '[v]', '-map', '[a]'],
      ['-c:v', 'libx264', '-preset', 'slower', '-crf', '26', '-profile:v', 'high', '-r', FPS],
      ['-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', OUT],
    ]
      .flat()
      .map(String),
  );
  ffmpeg(['-i', path.join(FRAMES, `${String(meta.poster).padStart(5, '0')}.jpg`), '-vf', 'scale=1280:-2', '-q:v', '3', POSTER]);
  const mb = (fs.statSync(OUT).size / 1e6).toFixed(1);
  console.log(`media/trailer.mp4 ${dur.toFixed(1)} s, ${mb} MB; poster media/trailer-poster.jpg`);
}

// ─────────────────────────────────────────────────────────── in-page runtime

/** Installed in the page: steps animations, eases the camera and draws the cursor, captions and end card. */
function runtime() {
  const { engine, app } = window.__solar;
  const css = document.createElement('style');
  css.textContent = `
    .unhide { display: none !important; }
    #rec { position: fixed; inset: 0; z-index: 9999; pointer-events: none; font-family: var(--font-display); }
    #rec .cap { position: absolute; left: 50%; bottom: 112px; padding: 14px 30px 16px; border-radius: 18px; text-align: center;
      background: var(--glass-bg); backdrop-filter: var(--glass-blur); border: 1px solid var(--glass-border); box-shadow: var(--shadow); opacity: 0; }
    #rec .eb { font-size: 12px; letter-spacing: 0.34em; text-transform: uppercase; color: var(--warm); }
    #rec .tx { margin-top: 6px; font-size: 27px; font-weight: 500; color: #fff; letter-spacing: 0.005em; white-space: nowrap; }
    #rec .cursor { position: absolute; left: 0; top: 0; filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.55)); opacity: 0; }
    #rec .ripple { position: absolute; left: 0; top: 0; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%;
      border: 2px solid rgba(255, 255, 255, 0.9); opacity: 0; }
    #rec .card { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; opacity: 0;
      background: radial-gradient(ellipse at center, rgba(3, 5, 12, 0.86), rgba(3, 5, 12, 0.95) 75%); text-align: center; }
    #rec .card h1 { margin: 18px 0 0; font-size: 128px; line-height: 0.95; letter-spacing: 0.16em; font-weight: 700; }
    #rec .card .a { background: linear-gradient(180deg, #fff, #ffe2b0 60%, #ffb35c); -webkit-background-clip: text; background-clip: text; color: transparent;
      filter: drop-shadow(0 0 30px rgba(255, 180, 90, 0.35)); }
    #rec .card .b { display: block; margin-top: 14px; font-size: 40px; font-weight: 300; letter-spacing: 0.9em; padding-left: 0.9em; color: rgba(225, 233, 255, 0.92); }
    #rec .card .eb { font-size: 15px; letter-spacing: 0.42em; }
    #rec .card p { margin: 34px 0 0; font-family: var(--font-ui); font-size: 22px; color: rgba(220, 228, 255, 0.8); }
    #rec .card .cta { margin-top: 44px; padding: 14px 30px; border-radius: 999px; font-size: 19px; letter-spacing: 0.08em; color: #8ec5ff;
      background: var(--glass-bg); border: 1px solid var(--glass-border); }
  `;
  document.head.append(css);
  const root = document.createElement('div');
  root.id = 'rec';
  root.innerHTML = `
    <div class="card"><div class="eb">A true-scale journey</div><h1><span class="a">SOLAR</span><span class="b">SYSTEM</span></h1>
      <p>Every planet, major moon, dwarf planet and famous comet, at its real position</p>
      <div class="cta">PLAY FREE IN YOUR BROWSER · echoness.itch.io/solar-system</div></div>
    <div class="cap"><div class="eb"></div><div class="tx"></div></div>
    <div class="ripple"></div>
    <svg class="cursor" width="30" height="30" viewBox="0 0 30 30"><path d="M5 3v20.5l5.4-5 3.9 8.3 3.7-1.7-3.8-8.1H22z" fill="#fff" stroke="#0b1020" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
  document.body.append(root);
  const el = (s) => root.querySelector(s);
  const [cap, eb, tx, cursor, ripple, card] = ['.cap', '.cap .eb', '.cap .tx', '.cursor', '.ripple', '.card'].map(el);

  const seen = new WeakSet();
  const st = { key: '', o: 0, bottom: 112, drift: { yaw: 0, pitch: 0, zoom: 0 }, ripple: 1, cursorO: 0, card: 0 };
  const approach = (cur, target, dt, tau) => cur + (target - cur) * (1 - Math.exp(-dt / tau));

  window.__rec = {
    frame(dt, s) {
      // CSS transitions, keyframe animations and Svelte transitions follow the video clock.
      for (const a of document.getAnimations()) {
        if (a.playState === 'finished' || a.playState === 'idle') {
          seen.add(a);
          continue;
        }
        if (!seen.has(a)) {
          seen.add(a);
          a.pause();
          a.currentTime = 0;
          continue;
        }
        const end = a.effect?.getComputedTiming().endTime ?? Number.POSITIVE_INFINITY;
        const t = Number(a.currentTime ?? 0) + dt * 1000;
        if (t >= end) a.finish();
        else {
          if (a.playState !== 'paused') a.pause();
          a.currentTime = t;
        }
      }

      // Camera: an absolute pose from the director, or a gentle drift once a flight lands.
      const rig = engine.rig;
      if (s.cam) {
        Object.assign(rig, s.cam);
        st.drift = { yaw: 0, pitch: 0, zoom: 0 };
      } else if (rig.flying) {
        st.drift = { yaw: 0, pitch: 0, zoom: 0 };
      } else {
        for (const k of ['yaw', 'pitch', 'zoom']) st.drift[k] = approach(st.drift[k], s.drift[k], dt, 0.9);
        rig.yaw += st.drift.yaw * dt;
        rig.pitch += st.drift.pitch * dt;
        rig.distance *= Math.exp(st.drift.zoom * dt);
      }

      // Caption: fade out, swap the text, fade back in.
      const key = s.caption ? `${s.caption[0]}|${s.caption[1]}` : '';
      if (key !== st.key) {
        st.o = Math.max(0, st.o - dt / 0.3);
        if (st.o === 0) {
          st.key = key;
          eb.textContent = s.caption?.[0] ?? '';
          tx.textContent = s.caption?.[1] ?? '';
        }
      } else if (key) st.o = Math.min(1, st.o + dt / 0.45);
      st.bottom = approach(st.bottom, app.hideUi ? 70 : 112, dt, 0.35);
      const e = st.o * st.o * (3 - 2 * st.o);
      cap.style.opacity = String(e);
      cap.style.bottom = `${st.bottom}px`;
      cap.style.transform = `translate(-50%, ${(1 - e) * 10}px)`;

      // Cursor and click ripple.
      st.cursorO = approach(st.cursorO, s.cursor.show ? 1 : 0, dt, 0.18);
      cursor.style.opacity = String(st.cursorO);
      cursor.style.transform = `translate(${s.cursor.x - 5}px, ${s.cursor.y - 3}px)`;
      if (s.click) st.ripple = 0;
      st.ripple = Math.min(1, st.ripple + dt / 0.5);
      ripple.style.opacity = String((1 - st.ripple) * 0.9 * st.cursorO);
      ripple.style.transform = `translate(${s.cursor.x}px, ${s.cursor.y}px) scale(${0.35 + st.ripple * 0.9})`;

      // Smooth scrolling of a panel.
      if (s.scroll) {
        const box = document.querySelector(s.scroll.sel);
        if (box) box.scrollTop = approach(box.scrollTop, s.scroll.y, dt, 0.28);
      }

      // Labels stay visible in cinematic (hidden-interface) shots when asked.
      if (s.labels !== null) document.querySelector('.labels')?.classList.toggle('hidden', !s.labels);

      st.card = Math.min(1, Math.max(0, st.card + (s.card ? dt : -dt) / 0.9));
      card.style.opacity = String(st.card * st.card * (3 - 2 * st.card));
      card.style.transform = `scale(${1.04 - 0.04 * st.card})`;

      return { flying: rig.flying, distance: rig.distance, yaw: rig.yaw, pitch: rig.pitch };
    },
  };
}

// ─────────────────────────────────────────────────────────── capture

async function capture() {
  const { chromium } = await import('playwright');
  const URL = process.env.APP_URL ?? 'http://localhost:5173';
  /** Stop early for quick previews: `npm run trailer -- --seconds=15`. */
  const limit = Number(process.argv.find((a) => a.startsWith('--seconds='))?.split('=')[1] ?? Number.POSITIVE_INFINITY);
  fs.rmSync(FRAMES, { recursive: true, force: true });
  fs.mkdirSync(FRAMES, { recursive: true });

  const browser = await chromium.launch({
    // Mesa llvmpipe renders about ten times faster than SwiftShader on a many-core CPU.
    args: ['--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl'],
    env: { ...process.env, EGL_PLATFORM: 'surfaceless' },
  });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  const cdp = await page.context().newCDPSession(page);

  // The fake clock runs in real time while the app loads, then pauses for recording.
  await page.clock.install();
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const until = async (fn, arg, sec = 240) => {
    const t0 = Date.now();
    while (!(await page.evaluate(fn, arg).catch(() => false))) {
      if (Date.now() - t0 > sec * 1000) throw new Error(`timed out waiting for ${fn}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  };
  await until(() => window.__solar?.app.stage === 'title');

  // Stream every map the tour visits at full resolution before the first frame.
  await page.evaluate(async () => {
    const { engine } = window.__solar;
    const ids = new Set(['stars']);
    for (const id of ['sun', 'earth', 'moon', 'jupiter', 'io', 'europa', 'ganymede', 'callisto', 'saturn', 'titan', 'halley']) {
      const v = engine.get(id)?.def.visual ?? {};
      for (const t of [v.map, v.night, v.clouds, v.normal, v.specular, v.rings?.texture]) if (t) ids.add(t);
    }
    await Promise.all([...ids].map((id) => engine.bank.upgrade(id)));
    window.__solar.app.toasts.splice(0);
  });
  // Let the dismissed toasts finish leaving on the real clock.
  await page.waitForTimeout(1500);
  await page.evaluate(runtime);
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);

  // ── director

  const S = {
    cursor: { x: W * 0.72, y: H * 0.86, show: false },
    click: false,
    caption: null,
    drift: { yaw: 0, pitch: 0, zoom: 0 },
    cam: null,
    scroll: null,
    labels: null,
    card: false,
  };
  let frame = 0;
  let poster = 0;
  let last = { flying: false };
  class Done extends Error {}

  async function shoot() {
    if (frame >= limit * FPS) throw new Done();
    await page.clock.runFor(STEP_MS);
    last = await page.evaluate(([dt, s]) => window.__rec.frame(dt, s), [1 / FPS, S]);
    S.click = false;
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 92, optimizeForSpeed: true });
    fs.writeFileSync(path.join(FRAMES, `${String(frame).padStart(5, '0')}.jpg`), Buffer.from(data, 'base64'));
    frame++;
    if (frame % FPS === 0) console.log(`  ${(frame / FPS).toFixed(0)} s`);
  }
  const hold = async (sec) => {
    for (let i = Math.round(sec * FPS); i > 0; i--) await shoot();
  };
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  async function glide(x, y, sec = 0.9) {
    const { x: x0, y: y0 } = S.cursor;
    S.cursor.show = true;
    const n = Math.max(1, Math.round(sec * FPS));
    for (let i = 1; i <= n; i++) {
      const k = ease(i / n);
      S.cursor.x = x0 + (x - x0) * k;
      S.cursor.y = y0 + (y - y0) * k;
      await page.mouse.move(S.cursor.x, S.cursor.y);
      await shoot();
    }
  }
  async function glideTo(locator, sec, dx = 0) {
    const b = await locator.boundingBox();
    await glide(b.x + Math.min(b.width / 2, 60) + dx, b.y + b.height / 2, sec);
  }
  async function click() {
    S.click = true;
    await page.mouse.down();
    await page.mouse.up();
    await shoot();
  }
  async function typeText(text, perChar = 0.09) {
    for (const ch of text) {
      await page.keyboard.type(ch);
      await hold(perChar);
    }
  }
  /** Records until the current (or imminent) camera flight lands. */
  async function flight(max = 12) {
    let n = 0;
    while (!last.flying && n++ < FPS) await shoot();
    while (last.flying && n++ < max * FPS) await shoot();
  }
  /** Eases the camera to an absolute pose; `yaw` turns relative to the start, `yawTo` to an absolute heading. */
  async function camTo({ distance, pitch, yaw = 0, yawTo }, sec) {
    const r0 = await page.evaluate(() => {
      const r = window.__solar.engine.rig;
      return { distance: r.distance, pitch: r.pitch, yaw: r.yaw };
    });
    const turn = yawTo === undefined ? yaw : Math.atan2(Math.sin(yawTo - r0.yaw), Math.cos(yawTo - r0.yaw));
    const n = Math.round(sec * FPS);
    for (let i = 1; i <= n; i++) {
      const k = ease(i / n);
      S.cam = {
        distance: Math.exp(Math.log(r0.distance) + (Math.log(distance ?? r0.distance) - Math.log(r0.distance)) * k),
        pitch: r0.pitch + ((pitch ?? r0.pitch) - r0.pitch) * k,
        yaw: r0.yaw + turn * k,
      };
      await shoot();
    }
    S.cam = null;
  }
  const js = (fn, arg) => page.evaluate(fn, arg);
  const browserItem = (name) => page.locator('nav.browser button.item', { hasText: new RegExp(`^\\s*${name}\\s*\\d*\\s*$`) }).first();

  try {
    // 1 · Title screen → begin.
    await hold(2.2);
    await glideTo(page.getByRole('button', { name: /begin the journey/i }), 1.1);
    await hold(0.25);
    await click();
    S.cursor.show = false;
    S.caption = ['True scale', '69 worlds at their real positions, right now'];
    await flight();

    // 2 · Earth, with the live info panel.
    S.drift = { yaw: 0.05, pitch: 0, zoom: 0 };
    await hold(1.6);
    S.caption = ['Live data', 'Click any world for live distance, speed and facts'];
    await glide(1700, 520, 1.0);
    S.scroll = { sel: 'aside.info .scroll', y: 420 };
    await hold(2.2);
    S.scroll = { sel: 'aside.info .scroll', y: 0 };
    await hold(0.6);

    // 3 · Search → Saturn.
    S.caption = ['Search', 'Search and fly anywhere'];
    await glideTo(page.locator('#search'), 0.9);
    await click();
    await typeText('Saturn');
    await hold(0.35);
    await glideTo(page.locator('.results li').first(), 0.6);
    await click();
    S.cursor.show = false;
    S.caption = ['Seamless flight', 'From planet to planet at the speed of thought'];
    await flight();
    S.drift = { yaw: 0.045, pitch: 0, zoom: -0.01 };
    S.caption = ['Real maps', 'Spacecraft imagery, rings and shadows lit in real time'];
    await hold(1.5);
    poster = frame;
    await hold(1.4);
    S.caption = ['Sound', 'Every world has a voice, from spacecraft recordings to live sonification'];
    await glide(1700, 620, 0.9);
    S.scroll = { sel: 'aside.info .scroll', y: 99999 };
    await hold(2.6);

    // 4 · Jupiter, with time sped up so the moons orbit.
    S.caption = ['Explore', 'Planets, moons, dwarf planets, asteroids and comets'];
    await glideTo(browserItem('Jupiter'), 1.0);
    await click();
    S.cursor.show = false;
    S.scroll = null;
    await flight();
    S.caption = ['Time', 'Speed up time and watch the moons go round'];
    await glideTo(page.getByRole('button', { name: 'Faster' }), 0.9);
    for (let i = 0; i < 4; i++) {
      await click();
      await hold(0.22);
    }
    S.cursor.show = false;
    await camTo({ distance: 3.2e6, pitch: 0.62, yaw: 0.3 }, 3.2);
    S.drift = { yaw: 0.03, pitch: 0, zoom: 0 };
    await hold(2.2);

    // 5 · Time travel to Halley's return in 2061.
    S.caption = ['Time travel', 'Visit any date from 1800 to 2200, or jump to famous events'];
    await glideTo(page.getByRole('button', { name: 'Time travel events' }), 1.0);
    await click();
    await hold(0.9);
    await glideTo(page.locator('section.panel button', { hasText: 'Halley returns' }), 0.9);
    await hold(0.2);
    await click();
    S.cursor.show = false;
    await flight();
    S.caption = ['Comets', 'Halley’s Comet, back in 2061 with its tails streaming from the Sun'];
    // Pull back to a side-on view, a little sunward, that streams the tail across the open left of the frame.
    const tailView = await js(() => {
      const [x, y] = window.__solar.engine.get('halley').pos;
      const t = Math.hypot(x, y);
      const [ax, az] = [x / t, -y / t]; // anti-sun direction, scene frame, horizontal part
      const a = 0.45;
      return Math.atan2(az * Math.cos(a) - ax * Math.sin(a), -ax * Math.cos(a) - az * Math.sin(a));
    });
    await camTo({ distance: 3.5e7, pitch: 0.3, yawTo: tailView }, 4.2);
    S.drift = { yaw: 0.04, pitch: 0, zoom: 0 };
    await hold(2.2);

    // 6 · The Sun, then a cinematic pull-back to the Kuiper belt.
    S.caption = ['The Sun', 'A boiling photosphere wrapped in a glowing corona'];
    await glideTo(browserItem('Sun'), 1.0);
    await click();
    S.cursor.show = false;
    await flight();
    S.drift = { yaw: 0.05, pitch: 0, zoom: -0.04 };
    await hold(1.2);
    await glideTo(page.getByRole('button', { name: 'Hide interface' }), 1.0);
    await click();
    S.cursor.show = false;
    S.labels = true;
    await hold(1.6);
    await js(() => window.__solar.engine.setRate(2629800));
    S.caption = ['True scale', 'From the surface of the Sun to the Kuiper belt'];
    await camTo({ distance: 1.3e10, pitch: 0.6, yaw: 0.5 }, 9);
    S.drift = { yaw: 0.02, pitch: 0, zoom: 0 };
    await hold(0.8);

    // 7 · End card.
    S.caption = null;
    S.labels = false;
    S.card = true;
    await hold(5);
  } catch (e) {
    if (!(e instanceof Done)) throw e;
  }

  fs.writeFileSync(path.join(WORK, 'meta.json'), `${JSON.stringify({ frames: frame, fps: FPS, poster })}\n`);
  console.log(`captured ${frame} frames (${(frame / FPS).toFixed(1)} s) to .cache/trailer/frames`);
  await browser.close();
}
