// Generates the media kit in media/: in-app screenshots plus composed itch.io
// cover, banner, page background, social card and logo.
//
// Scenes are captured from the running dev server in headless Chromium; the
// composed images are HTML templates rendered by the same browser, so they use
// the app's own fonts.
//
// Run in Docker: docker compose up -d dev && docker compose run --rm browser npm run media [scene…]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';

const URL = process.env.APP_URL ?? 'http://localhost:5173';
const OUT = path.resolve('media');
const SHOTS = path.join(OUT, 'screenshots');
const RAW = path.resolve('.cache/media-raw');
const W = 1920;
const H = 1080;
const jd = (iso) => Date.parse(iso) / 86400000 + 2440587.5;

/**
 * Each scene: target body, optional date, camera tweaks relative to the
 * engine's arrival pose, and whether the interface is shown.
 */
const SCENES = [
  { name: 'saturn', focus: 'saturn', zoom: 0.92, yaw: 0.25, pitch: 0.05, caption: 'Saturn and its rings, lit and shadowed in real time' },
  { name: 'earth', focus: 'earth', zoom: 0.9, yaw: -0.35, caption: 'Earth with live clouds, city lights and atmosphere' },
  { name: 'jupiter', focus: 'jupiter', zoom: 0.95, yaw: 0.2, caption: 'Jupiter at its true position for the current date' },
  { name: 'sun', focus: 'sun', zoom: 1.15, caption: 'The Sun’s boiling photosphere' },
  { name: 'pluto', focus: 'pluto', zoom: 0.9, yaw: -0.3, caption: 'Pluto and its heart, from New Horizons maps' },
  {
    name: 'halley-1986',
    focus: 'halley',
    date: '1986-02-20T00:00Z',
    zoom: 1.5e6,
    yaw: 0.7,
    pitch: 0.1,
    orbits: false,
    caption: 'Halley’s Comet near perihelion in 1986',
  },
  { name: 'inner-system', focus: 'sun', zoom: 210, pitch: 0.45, labels: true, caption: 'The inner Solar System, true to scale' },
  { name: 'outer-belts', focus: 'sun', zoom: 3800, pitch: 0.5, labels: true, caption: 'The Kuiper belt beyond Neptune' },
  { name: 'ui-earth', focus: 'earth', zoom: 1.05, yaw: -0.35, ui: true, caption: 'Glass interface with live data for every world' },
  {
    name: 'ui-saturn-events',
    focus: 'saturn',
    zoom: 1.1,
    yaw: 0.25,
    ui: true,
    panel: 'eventsOpen',
    caption: 'Time-travel to historic and upcoming events',
  },
];

// `--compose` re-renders the composed images from the last capture.
const composeOnly = process.argv.includes('--compose');
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
for (const dir of [OUT, SHOTS, RAW]) fs.mkdirSync(dir, { recursive: true });

const browser = await chromium.launch({
  args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
});

// ─────────────────────────────────────────────────────────── capture

async function capture() {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__solar?.app.stage === 'title', null, { timeout: 240_000 });
  await page.evaluate(() => window.__solar.app.toasts.splice(0));
  await page.getByRole('button', { name: /begin the journey/i }).click();
  await page.waitForFunction(() => window.__solar.engine.rig.flying, null, { timeout: 30_000 });
  await page.addStyleTag({ content: '.unhide { display: none !important; }' });
  const nowJd = await page.evaluate(() => window.__solar.engine.jd);

  const frames = (n) =>
    page.evaluate(
      (n) =>
        new Promise((resolve) => {
          const e = window.__solar.engine;
          const start = e.frames;
          const tick = () => (e.frames >= start + n && !e.rig.flying ? resolve() : requestAnimationFrame(tick));
          tick();
        }),
      n,
    );

  for (const s of SCENES) {
    if (only.length && !only.includes(s.name)) continue;
    await page.evaluate(
      ({ s, when }) => {
        const { app, engine, audio } = window.__solar;
        audio.applySettings({ ...app.settings, muted: true });
        app.toasts.splice(0);
        app.settingsOpen = app.helpOpen = app.creditsOpen = app.eventsOpen = false;
        app.hideUi = !s.ui;
        app.settings.orbits = s.orbits ?? true;
        app.settings.labels = s.labels ?? s.ui ?? false;
        engine.applySettings({ ...app.settings, quality: 'high' });
        engine.setJd(when);
        engine.setPaused(true);
        engine.focus(s.focus, { instant: true });
      },
      { s, when: s.date ? jd(s.date) : nowJd },
    );
    await frames(3);
    await page.evaluate((s) => {
      const { app, engine } = window.__solar;
      const rig = engine.rig;
      rig.distance *= s.zoom ?? 1;
      rig.yaw += s.yaw ?? 0;
      rig.pitch += s.pitch ?? 0;
      if (s.panel) app[s.panel] = true;
      // Labels are hidden along with the UI; scenes can still ask for them.
      document.querySelector('.labels')?.classList.toggle('hidden', !(s.labels || s.ui));
    }, s);
    // Let high-resolution maps stream in, then settle a few frames.
    await page
      .waitForFunction(
        (id) => {
          const e = window.__solar.engine;
          const map = e.get(id)?.def.visual.map;
          return !map || e.bank.isHigh(map);
        },
        s.focus,
        { timeout: 30_000 },
      )
      .catch(() => console.warn(`  ${s.name}: high-res map not ready`));
    await page.waitForTimeout(1200);
    await frames(4);
    const file = path.join(RAW, `${s.name}.png`);
    await page.screenshot({ path: file, timeout: 180_000 });
    console.log(`scene ${s.name}`);
  }
  await page.close();
}

// ─────────────────────────────────────────────────────────── compose

const font = (pkg, file) => fs.readFileSync(path.resolve('node_modules/@fontsource-variable', pkg, 'files', file)).toString('base64');
const FONTS = `
  @font-face { font-family: 'Space Grotesk'; font-weight: 300 700; src: url(data:font/woff2;base64,${font('space-grotesk', 'space-grotesk-latin-wght-normal.woff2')}) format('woff2'); }
  @font-face { font-family: 'Inter'; font-weight: 100 900; src: url(data:font/woff2;base64,${font('inter', 'inter-latin-wght-normal.woff2')}) format('woff2'); }
`;
const img = async (name, width = 1920) =>
  `data:image/jpeg;base64,${(
    await sharp(path.join(RAW, `${name}.png`))
      .resize({ width })
      .jpeg({ quality: 90 })
      .toBuffer()
  ).toString('base64')}`;

const BASE_CSS = `
  ${FONTS}
  * { box-sizing: border-box; margin: 0; }
  html, body { width: 100%; height: 100%; background: #03050c; overflow: hidden; }
  body { position: relative; font-family: 'Inter', sans-serif; color: #eef2ff; }
  .bg { position: absolute; inset: 0; background-size: cover; background-position: center; }
  .shade { position: absolute; inset: 0; }
  .title { font-family: 'Space Grotesk', sans-serif; letter-spacing: 0.16em; line-height: 0.95; }
  .solar { font-weight: 700; background: linear-gradient(180deg, #fff, #ffe2b0 60%, #ffb35c); -webkit-background-clip: text; background-clip: text; color: transparent; filter: drop-shadow(0 0 24px rgba(255, 180, 90, 0.35)); }
  .system { font-weight: 300; color: rgba(225, 233, 255, 0.92); }
  .eyebrow { font-family: 'Space Grotesk', sans-serif; text-transform: uppercase; color: #ffcf8f; }
  .tag { color: rgba(220, 228, 255, 0.82); }
`;

async function render(name, width, height, body, css = '') {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html><head><style>${BASE_CSS}${css}</style></head><body>${body}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  const file = path.join(OUT, name);
  await page.screenshot({ path: file, type: name.endsWith('.jpg') ? 'jpeg' : 'png', quality: name.endsWith('.jpg') ? 90 : undefined });
  await page.close();
  console.log(`media ${name} ${width}×${height}`);
}

async function compose() {
  const have = (n) => fs.existsSync(path.join(RAW, `${n}.png`));
  const scenes = SCENES.filter((s) => have(s.name));

  // Screenshots, numbered in scene order.
  for (const [i, s] of scenes.entries()) {
    await sharp(path.join(RAW, `${s.name}.png`))
      .jpeg({ quality: 90, mozjpeg: true })
      .toFile(path.join(SHOTS, `${String(i + 1).padStart(2, '0')}-${s.name}.jpg`));
  }
  fs.writeFileSync(
    path.join(SHOTS, 'captions.json'),
    `${JSON.stringify(Object.fromEntries(scenes.map((s, i) => [`${String(i + 1).padStart(2, '0')}-${s.name}.jpg`, s.caption])), null, 2)}\n`,
  );

  // itch.io cover (630×500).
  await render(
    'cover.png',
    630,
    500,
    `<div class="bg" style="background-image:url(${await img('saturn', 1200)}); background-position: 46% 50%; background-size: 155%"></div>
     <div class="shade" style="background: linear-gradient(180deg, rgba(3,5,12,0) 45%, rgba(3,5,12,0.92) 88%)"></div>
     <div style="position:absolute; left:34px; right:34px; bottom:30px">
       <div class="eyebrow" style="font-size:11px; letter-spacing:0.38em; margin-bottom:10px">A true-scale journey</div>
       <div class="title" style="font-size:64px"><span class="solar">SOLAR</span> <span class="system" style="font-size:0.5em; letter-spacing:0.5em">SYSTEM</span></div>
     </div>`,
  );

  // itch.io page banner (header image), 960 wide and a 2× version.
  for (const [file, scale] of [
    ['banner.png', 1],
    ['banner@2x.png', 2],
  ]) {
    await render(
      file,
      960 * scale,
      300 * scale,
      `<div class="bg" style="background-image:url(${await img('sun', 1920)}); background-size: 150%; background-position: 0% 50%; filter: saturate(1.1)"></div>
       <div class="shade" style="background: linear-gradient(90deg, rgba(3,5,12,0.92) 0%, rgba(3,5,12,0.7) 38%, rgba(3,5,12,0) 62%)"></div>
       <div style="position:absolute; left:${64 * scale}px; top:0; bottom:0; display:flex; flex-direction:column; justify-content:center">
         <div class="eyebrow" style="font-size:${11 * scale}px; letter-spacing:0.42em">A true-scale journey</div>
         <div class="title" style="font-size:${84 * scale}px; margin-top:${12 * scale}px"><span class="solar">SOLAR</span></div>
         <div class="title system" style="font-size:${28 * scale}px; letter-spacing:0.9em; margin-top:${6 * scale}px">SYSTEM</div>
       </div>`,
    );
  }

  // itch.io page background: dark space with planets at the edges, quiet in
  // the middle where the 960 px content column sits.
  await render(
    'background.jpg',
    2560,
    1440,
    `<div class="bg" style="background-image:url(${await img('outer-belts', 2560)}); opacity:0.55; filter: blur(1px)"></div>
     <div class="bg" style="left:-14%; right:auto; width:58%; background-image:url(${await img('jupiter', 1920)}); background-size: 160%; background-position: 50% 50%; -webkit-mask-image: radial-gradient(closest-side, #000 55%, transparent 100%); opacity:0.9"></div>
     <div class="bg" style="left:auto; right:-16%; width:60%; background-image:url(${await img('saturn', 1920)}); background-size: 150%; background-position: 50% 50%; -webkit-mask-image: radial-gradient(closest-side, #000 50%, transparent 100%); opacity:0.9"></div>
     <div class="shade" style="background: linear-gradient(90deg, rgba(3,5,12,0) 0%, rgba(3,5,12,0.88) 31%, rgba(3,5,12,0.92) 50%, rgba(3,5,12,0.88) 69%, rgba(3,5,12,0) 100%)"></div>`,
  );

  // Social card (Open Graph / README hero), 1200×630.
  await render(
    'social-card.png',
    1200,
    630,
    `<div class="bg" style="background-image:url(${await img('saturn', 1920)}); background-size: 118%; background-position: 70% 50%"></div>
     <div class="shade" style="background: linear-gradient(90deg, rgba(3,5,12,0.94) 0%, rgba(3,5,12,0.75) 38%, rgba(3,5,12,0) 70%)"></div>
     <div style="position:absolute; left:70px; top:0; bottom:0; display:flex; flex-direction:column; justify-content:center; max-width:560px">
       <div class="eyebrow" style="font-size:15px; letter-spacing:0.4em">A true-scale journey</div>
       <div class="title" style="font-size:104px; margin-top:16px"><span class="solar">SOLAR</span></div>
       <div class="title system" style="font-size:36px; letter-spacing:0.86em; margin-top:8px">SYSTEM</div>
       <p class="tag" style="font-size:21px; line-height:1.5; margin-top:28px">Every planet, major moon, dwarf planet and famous comet at its real position — with real surface maps and the sounds of every world.</p>
       <p style="margin-top:26px; font-size:16px; letter-spacing:0.08em; color:#8ec5ff">PLAY FREE IN YOUR BROWSER · echoness.itch.io/solar-system</p>
     </div>`,
  );

  // Square logo / icon (512×512).
  await render(
    'logo.png',
    512,
    512,
    `<div class="bg" style="border-radius:112px; overflow:hidden; background:#060a18"></div>
     <svg viewBox="0 0 64 64" style="position:absolute; inset:0; width:100%; height:100%">
       <defs><radialGradient id="s" cx="0.42" cy="0.4" r="0.6"><stop offset="0" stop-color="#fff6d8"/><stop offset="0.55" stop-color="#ffc35c"/><stop offset="1" stop-color="#ff7a1f"/></radialGradient>
       <filter id="g"><feGaussianBlur stdDeviation="2.4"/></filter></defs>
       <rect width="64" height="64" rx="14" fill="#060a18"/>
       <circle cx="32" cy="32" r="13" fill="#ffb35c" opacity="0.45" filter="url(#g)"/>
       <ellipse cx="32" cy="32" rx="26" ry="9" fill="none" stroke="#8ec5ff" stroke-opacity="0.6" stroke-width="1.6" transform="rotate(-18 32 32)"/>
       <circle cx="32" cy="32" r="11" fill="url(#s)"/>
       <circle cx="54" cy="24.5" r="3.4" fill="#8ec5ff"/>
     </svg>`,
    'html, body { background: transparent; }',
  );
}

try {
  if (!composeOnly) await capture();
  await compose();
} finally {
  await browser.close();
}
