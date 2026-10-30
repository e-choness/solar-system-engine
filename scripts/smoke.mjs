// Visual smoke test: opens the dev server in headless Chromium, cuts to a set of
// worlds and saves screenshots plus the browser console to .cache/smoke.
//
// Run in Docker: docker compose up -d dev && docker compose run --rm browser node scripts/smoke.mjs [ids…]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const URL = process.env.APP_URL ?? 'http://localhost:5173';
const OUT = path.resolve('.cache/smoke');
const targets = process.argv.slice(2).length ? process.argv.slice(2) : ['earth', 'moon', 'saturn', 'jupiter', 'sun', 'halley'];
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const log = [];
page.on('console', (m) => log.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => log.push(`[pageerror] ${e.stack ?? e.message}`));

const shot = async (name) => {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const fps = await page.evaluate(() => window.__solar?.app.telemetry?.fps ?? 0).catch(() => 0);
  console.log(`shot ${name}  (${fps.toFixed(1)} fps)`);
};
/** Waits for `n` rendered frames with no camera flight in progress. */
const settle = async (n = 4) => {
  const start = await page.evaluate(() => window.__solar.engine.frames);
  await page.waitForFunction(([s, k]) => window.__solar.engine.frames >= s + k && !window.__solar.engine.rig.flying, [start, n], {
    timeout: 300_000,
  });
};

try {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => ['title', 'error'].includes(window.__solar?.app.stage), null, { timeout: 180_000 });
  const stage = await page.evaluate(() => [window.__solar.app.stage, window.__solar.app.error, window.__solar.engine.backend]);
  console.log('stage', stage);
  await settle(3);
  await shot('00-title');
  if (stage[0] === 'title') {
    await page.getByRole('button', { name: /begin the journey/i }).click();
    // begin() starts audio, then its own flight to Earth; let that start before cutting away.
    await page.waitForFunction(() => window.__solar.engine.rig.flying, null, { timeout: 30_000 });
    let k = 1;
    for (const id of targets) {
      await page.evaluate((id) => window.__solar.engine.focus(id, { instant: true }), id);
      await settle(3);
      await page.waitForTimeout(1500); // high-res textures stream in
      await settle(3);
      await shot(`${String(k++).padStart(2, '0')}-${id}`);
      console.log('  audio', await page.evaluate(() => [window.__solar.audio.ctx?.state, window.__solar.audio.playingId]));
    }
  }
} catch (err) {
  console.error('smoke failed:', err.message);
  await shot('zz-failure').catch(() => undefined);
} finally {
  fs.writeFileSync(path.join(OUT, 'console.log'), log.join('\n'));
  console.log(`console: ${log.length} lines, ${log.filter((l) => /^\[(error|pageerror)/.test(l)).length} errors`);
  await browser.close();
}
