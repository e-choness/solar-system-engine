// Renders every sonified body voice offline in Chromium and measures its
// loudness (K-weighted, ungated LUFS), to calibrate RENDERED_LUFS in
// src/audio/sonify.ts. Voices should come out near the mixer's target.
//
//   docker compose up -d dev
//   docker compose run --rm browser node scripts/measure-voices.mjs
import { chromium } from 'playwright';

const URL = process.env.APP_URL ?? 'http://localhost:5173';
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${URL}/favicon.svg`);
const result = await page.evaluate(async () => {
  const { sonify, sonificationParams, RENDERED_LUFS } = await import('/src/audio/sonify.ts');
  const { TARGET_LUFS } = await import('/src/audio/loudness.ts');
  const { CATALOG } = await import('/src/data/catalog.ts');
  const RATE = 48000;
  const SECONDS = 20;
  /** Skips the 2.5 s fade-in. */
  const FROM = 3;

  async function render(def) {
    const ctx = new OfflineAudioContext(2, RATE * SECONDS, RATE);
    // K-weighting (ITU-R BS.1770): high shelf, then high-pass.
    const shelf = ctx.createBiquadFilter();
    shelf.type = 'highshelf';
    shelf.frequency.value = 1681;
    shelf.gain.value = 4;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 38;
    hp.Q.value = 0.5;
    const bus = ctx.createGain();
    bus.connect(shelf).connect(hp).connect(ctx.destination);
    // The voice's repeating events (metal pings, Earth's chirps) run on timers; replay them on the offline clock.
    const timers = [];
    const setInterval = window.setInterval;
    window.setInterval = (fn, ms) => timers.push({ fn, period: ms / 1000, next: ms / 1000 });
    sonify(ctx, def, bus, ctx.createGain());
    window.setInterval = setInterval;
    for (let t = 0.05; t < SECONDS; t += 0.05) {
      ctx.suspend(t).then(() => {
        for (const timer of timers) {
          while (timer.next <= ctx.currentTime) {
            timer.fn();
            timer.next += timer.period;
          }
        }
        ctx.resume();
      });
    }
    const buf = await ctx.startRendering();
    let sum = 0;
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let ms = 0;
      for (let i = RATE * FROM; i < d.length; i++) ms += d[i] * d[i];
      sum += ms / (d.length - RATE * FROM);
    }
    return -0.691 + 10 * Math.log10(sum);
  }

  const rows = [];
  for (const def of CATALOG) if (!def.audio.src) rows.push({ id: def.id, timbre: sonificationParams(def).timbre, lufs: await render(def) });
  return { rows, target: TARGET_LUFS, rendered: RENDERED_LUFS };
});
await browser.close();

for (const r of result.rows) console.log(`${r.id.padEnd(14)} ${r.timbre.padEnd(6)} ${r.lufs.toFixed(1).padStart(6)} LUFS`);
console.log(`\ntarget ${result.target} LUFS. Per timbre (mean, and the RENDERED_LUFS that would centre it):`);
const timbres = [...new Set(result.rows.map((r) => r.timbre))];
for (const t of timbres) {
  const xs = result.rows.filter((r) => r.timbre === t).map((r) => r.lufs);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const spread = `${Math.min(...xs).toFixed(1)} … ${Math.max(...xs).toFixed(1)}`;
  console.log(`  ${t.padEnd(6)} ${mean.toFixed(1).padStart(6)}  (${spread})  → ${(result.rendered[t] + mean - result.target).toFixed(1)}`);
}
