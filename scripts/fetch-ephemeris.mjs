// Pulls osculating orbital elements for every moon and small body in the
// catalog from NASA/JPL Horizons and writes src/data/generated/ephemeris.json.
//
// Moons are sampled at two epochs 200 days apart so the mean motion and the
// precession of node and periapsis can be fitted; the game then propagates
// mean elements, which stays accurate for years around the epoch.
//
// Run in Docker: docker compose run --rm node npm run ephemeris
import fs from 'node:fs';
import path from 'node:path';
import { CATALOG } from '../src/data/catalog.ts';

const API = 'https://ssd.jpl.nasa.gov/api/horizons.api';
const EPOCH = '2026-11-01';
const SPAN_DAYS = 200;
const OUT = path.resolve('src/data/generated/ephemeris.json');

/** Horizons center codes for each parent body. */
const CENTER = {
  sun: '500@10',
  earth: '500@399',
  mars: '500@499',
  jupiter: '500@599',
  saturn: '500@699',
  uranus: '500@799',
  neptune: '500@899',
  pluto: '500@999',
  eris: '500@20136199',
};

/** Small moons of Pluto orbit the Pluto–Charon barycenter, not Pluto itself. */
const BARYCENTRIC = { nix: '500@9', hydra: '500@9' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wrap = (d) => ((d % 360) + 360) % 360;
const addDays = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 864e5).toISOString().slice(0, 10);

async function elements(command, center, start) {
  const params = new URLSearchParams({
    format: 'json',
    COMMAND: `'${command}'`,
    OBJ_DATA: 'NO',
    MAKE_EPHEM: 'YES',
    EPHEM_TYPE: 'ELEMENTS',
    CENTER: `'${center}'`,
    REF_PLANE: 'ECLIPTIC',
    REF_SYSTEM: 'J2000',
    START_TIME: `'${start}'`,
    STOP_TIME: `'${addDays(start, 1)}'`,
    STEP_SIZE: "'2d'",
    OUT_UNITS: 'KM-S',
    CSV_FORMAT: 'YES',
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${API}?${params}`);
    if (res.status === 503 || res.status === 429) {
      await sleep(3000 * (attempt + 1));
      continue;
    }
    const json = await res.json();
    const text = json.result ?? '';
    const block = text.split('$$SOE')[1]?.split('$$EOE')[0];
    if (!block) throw new Error(text.split('\n').slice(0, 12).join('\n'));
    const f = block
      .trim()
      .split('\n')[0]
      .split(',')
      .map((s) => s.trim());
    // JDTDB, Cal, EC, QR, IN, OM, W, Tp, N, MA, TA, A, AD, PR
    return {
      jd: Number(f[0]),
      e: Number(f[2]),
      i: Number(f[4]),
      node: Number(f[5]),
      peri: Number(f[6]),
      n: Number(f[8]) * 86400,
      M: Number(f[9]),
      a: Number(f[11]),
    };
  }
  throw new Error('Horizons kept returning 503');
}

const result = {
  source: 'NASA/JPL Horizons (osculating elements, ecliptic & equinox J2000)',
  epoch: EPOCH,
  bodies: {},
};

for (const body of CATALOG) {
  if (!body.horizons) continue;
  const center = BARYCENTRIC[body.id] ?? CENTER[body.parent];
  try {
    const a = await elements(body.horizons, center, EPOCH);
    const entry = {
      center: body.parent,
      barycentric: Boolean(BARYCENTRIC[body.id]),
      epoch: a.jd,
      a: a.a,
      e: a.e,
      i: a.i,
      node: a.node,
      peri: a.peri,
      M: a.M,
      n: a.n,
      nodeRate: 0,
      periRate: 0,
    };
    if (body.kind === 'moon') {
      await sleep(400);
      const b = await elements(body.horizons, center, addDays(EPOCH, SPAN_DAYS));
      const dt = b.jd - a.jd;
      // Mean longitude λ = Ω + ω + M is well defined even for near-circular orbits.
      const lam1 = a.node + a.peri + a.M;
      const lam2 = b.node + b.peri + b.M;
      const turns = Math.round((a.n * dt - wrap(lam2 - lam1)) / 360);
      entry.n = (wrap(lam2 - lam1) + 360 * turns) / dt;
      const dNode = ((b.node - a.node + 540) % 360) - 180;
      const dVarpi = ((b.node + b.peri - (a.node + a.peri) + 540) % 360) - 180;
      if (a.i > 0.5) entry.nodeRate = dNode / dt;
      if (a.e > 0.01) entry.periRate = dVarpi / dt; // rate of ϖ = Ω + ω
    }
    result.bodies[body.id] = entry;
    console.log(`${body.id.padEnd(12)} a=${a.a.toExponential(4)} km  e=${a.e.toFixed(4)}  i=${a.i.toFixed(2)}°`);
  } catch (err) {
    console.warn(`!! ${body.id}: ${String(err.message).split('\n').slice(-3).join(' | ')}`);
  }
  await sleep(400);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(result, null, 1)}\n`);
console.log(`\nwrote ${Object.keys(result.bodies).length} bodies → ${path.relative(process.cwd(), OUT)}`);
