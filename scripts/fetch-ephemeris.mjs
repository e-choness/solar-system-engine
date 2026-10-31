// Pulls osculating orbital elements for the planets, moons and small bodies in
// the catalog from NASA/JPL Horizons and writes src/data/generated/ephemeris.json.
//
// Each body is sampled every few days across the game's 1800–2200 window, the
// angles are unwrapped (node, longitude of periapsis ϖ, mean longitude λ) and
// the series is thinned to the epochs needed so that linear interpolation
// between neighbours reproduces every sample to within a tolerance. Near-Earth
// asteroids also get hourly samples around their closest approaches to Earth.
// The game interpolates between epochs, so positions track JPL's integrated
// ephemerides instead of drifting away from a single fitted orbit. Every
// series is decoded and checked against all samples before it is written.
//
// The Moon is computed from a lunar theory (src/engine/moon.ts); it only gets
// a single epoch here for its period.
//
// Run in Docker: docker compose run --rm node npm run ephemeris [ids…] [--dry]
// (about ten minutes for everything; Horizons responses are cached in
// .cache/horizons, so re-tuning tolerances is quick. TOL_SCALE=2 doubles them.)
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CATALOG } from '../src/data/catalog.ts';

const API = 'https://ssd.jpl.nasa.gov/api/horizons.api';
const CAD = 'https://ssd-api.jpl.nasa.gov/cad.api';
const START = '1800-01-01';
const STOP = '2200-01-01';
const OUT = path.resolve('src/data/generated/ephemeris.json');
const DEG = Math.PI / 180;

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

/**
 * Planets are not in the catalog's Horizons list. Planets with moons use their
 * system barycentre: the planet's own centre wobbles around it (Jupiter by
 * ~100 km with the Galilean moons), which would show up as day-scale jitter in
 * its heliocentric elements. Earth is the Earth–Moon barycentre, Pluto the
 * Pluto–Charon barycentre; the game splits those pairs itself.
 */
const PLANETS = {
  mercury: '199',
  venus: '299',
  earth: '3',
  mars: '4',
  jupiter: '5',
  saturn: '6',
  uranus: '7',
  neptune: '8',
  pluto: '9',
};

/** Small moons of Pluto orbit the Pluto–Charon barycenter, not Pluto itself. */
const BARYCENTRIC = { nix: '500@9', hydra: '500@9' };

/** Bodies whose position comes from a dedicated theory. */
const SINGLE_EPOCH = new Set(['moon']);
/** Mean sidereal motion (deg/day) of those, for the period shown in the info panel: the Moon's from its theory's L′. */
const MEAN_MOTION = { moon: 481267.88123421 / 36525 };
const EPOCH = '2026-11-01';

/**
 * Sampling step (days) and thinning tolerance (fraction of the distance from
 * the centre): 2e-5 is 4″ as seen from the Sun, 3e-4 about 1′. Earth is
 * tighter because near-Earth asteroid flybys are measured against it. Moons
 * are limited by their own short-period wobble (Jupiter's oblateness alone
 * makes Io's osculating orbit breathe by ~0.1 % twice per revolution).
 */
function plan(def) {
  if (def.id === 'earth') return { step: 20, tol: 5e-6 };
  if (PLANETS[def.id]) return { step: 20, tol: 2e-5 };
  if (def.kind === 'moon') return { step: 10, tol: 3e-3 };
  if (def.kind === 'comet' || /near-earth/i.test(def.class)) return { step: 10, tol: 3e-4 };
  return { step: 30, tol: 3e-4 };
}
/** Tolerance divisor inside close-approach windows (3e-4 → 1e-6, ~150 km at 1 au). */
const TIGHT = 300;
/** Share of the tolerance the thinning may use; the rest is left for quantization. */
const MARGIN = 0.85;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mod360 = (d) => ((d % 360) + 360) % 360;
const near = (d) => d - 360 * Math.round(d / 360);

/** Raw responses are cached so the thinning can be re-tuned without hitting the API again. */
const CACHE = path.resolve('.cache/horizons');

async function get(url) {
  const file = path.join(CACHE, `${createHash('sha1').update(String(url)).digest('hex')}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url);
    if (res.status === 503 || res.status === 429) {
      await sleep(3000 * (attempt + 1));
      continue;
    }
    const json = await res.json();
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(json));
    await sleep(400);
    return json;
  }
  throw new Error('Horizons kept returning 503');
}

/** Osculating elements on a regular grid (or a single epoch). Narrows the span when the ephemeris has limits. */
async function elements(command, center, start, stop, step) {
  let [a, b] = [start, stop];
  for (let attempt = 0; attempt < 4; attempt++) {
    const params = new URLSearchParams({
      format: 'json',
      COMMAND: `'${command}'`,
      OBJ_DATA: 'NO',
      MAKE_EPHEM: 'YES',
      EPHEM_TYPE: 'ELEMENTS',
      CENTER: `'${center}'`,
      REF_PLANE: 'ECLIPTIC',
      REF_SYSTEM: 'J2000',
      START_TIME: `'${a}'`,
      STOP_TIME: `'${b}'`,
      STEP_SIZE: `'${step}'`,
      OUT_UNITS: 'KM-S',
      CSV_FORMAT: 'YES',
    });
    const text = (await get(`${API}?${params}`)).result ?? '';
    const block = text.split('$$SOE')[1]?.split('$$EOE')[0];
    if (block) {
      // JDTDB, Cal, EC, QR, IN, OM, W, Tp, N, MA, TA, A, AD, PR
      return block
        .trim()
        .split('\n')
        .map((line) => {
          const f = line.split(',').map((s) => s.trim());
          return {
            t: Number(f[0]),
            e: Number(f[2]),
            i: Number(f[4]),
            node: Number(f[5]),
            peri: Number(f[6]),
            n: Number(f[8]) * 86400,
            M: Number(f[9]),
            a: Number(f[11]),
          };
        });
    }
    // "No ephemeris for target … prior to A.D. 1900-JAN-01 …" / "… after A.D. 2100-JAN-01 …"
    const prior = text.match(/prior to A\.D\. (\d{4})-([A-Z]{3})-(\d{2})/);
    const after = text.match(/after A\.D\. (\d{4})-([A-Z]{3})-(\d{2})/);
    // One day inside the reported limit.
    const inside = (m, days) => {
      const month = 'JANFEBMARAPRMAYJUNJULAUGSEPOCTNOVDEC'.indexOf(m[2]) / 3;
      return new Date(Date.UTC(Number(m[1]), month, Number(m[3])) + days * 864e5).toISOString().slice(0, 10);
    };
    if (prior) a = inside(prior, 1);
    else if (after) b = inside(after, -1);
    else throw new Error(text.split('\n').slice(0, 14).join('\n'));
    console.log(`   limited span: ${a} … ${b}`);
  }
  throw new Error('could not find a usable time span');
}

/**
 * The span in 50-year pieces. Horizons can lose a close planetary encounter
 * in a single long request (a 1800–2200 request for Apophis never makes the
 * 2029 flyby, while 1900–2100 does), so near-Earth asteroids are fetched this way.
 */
async function chunkedElements(command, center, step) {
  const rows = [];
  for (let year = Number(START.slice(0, 4)); year < Number(STOP.slice(0, 4)); year += 50) {
    try {
      rows.push(...(await elements(command, center, `${year}-01-01`, `${year + 50}-01-01`, step)));
    } catch (err) {
      // Outside the body's ephemeris altogether.
      const reason = String(err.message)
        .split('\n')
        .find((l) => l.trim());
      console.log(`   ${year}–${year + 50}: ${reason ?? 'no data'}`);
    }
  }
  return rows;
}

/** Closest approaches to Earth within 0.01 au (JPL SBDB close-approach data). */
async function closeApproaches(designation) {
  const u = new URL(CAD);
  u.search = new URLSearchParams({ des: designation, 'date-min': '1900-01-01', 'date-max': '2199-12-31', 'dist-max': '0.01' }).toString();
  const json = await get(u);
  const fields = json.fields ?? [];
  return (json.data ?? []).map((row) => Number(row[fields.indexOf('jd')]));
}

/** Angles unwrapped so they can be interpolated linearly: node, ϖ = Ω + ω, λ = ϖ + M. */
function unwrap(rows) {
  const out = [];
  for (const r of rows) {
    const node = r.node;
    const varpi = r.node + r.peri;
    const lambda = varpi + r.M;
    const prev = out.at(-1);
    if (!prev) {
      out.push({ ...r, node, varpi, lambda });
      continue;
    }
    const dt = r.t - prev.t;
    const nodeU = prev.node + near(node - prev.node);
    const varpiU = prev.varpi + near(varpi - prev.varpi);
    // λ advances by ~n·dt: pick the number of whole turns closest to that.
    const step = mod360(lambda - prev.lambda);
    const turns = Math.round((((prev.n + r.n) / 2) * dt - step) / 360);
    out.push({ ...r, node: nodeU, varpi: varpiU, lambda: prev.lambda + step + 360 * turns });
  }
  return out;
}

function kepler(M, e) {
  let E = e < 0.8 ? M : Math.PI * Math.sign(M || 1);
  for (let k = 0; k < 60; k++) {
    const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-14) break;
  }
  return E;
}

function position(s) {
  const peri = (s.varpi - s.node) * DEG;
  const M = (((s.lambda - s.varpi) % 360) + 360) % 360;
  const E = kepler((M > 180 ? M - 360 : M) * DEG, s.e);
  const xp = s.a * (Math.cos(E) - s.e);
  const yp = s.a * Math.sqrt(1 - s.e * s.e) * Math.sin(E);
  const [cO, sO, ci, si, cw, sw] = [
    Math.cos(s.node * DEG),
    Math.sin(s.node * DEG),
    Math.cos(s.i * DEG),
    Math.sin(s.i * DEG),
    Math.cos(peri),
    Math.sin(peri),
  ];
  return [
    (cO * cw - sO * sw * ci) * xp + (-cO * sw - sO * cw * ci) * yp,
    (sO * cw + cO * sw * ci) * xp + (-sO * sw + cO * cw * ci) * yp,
    sw * si * xp + cw * si * yp,
  ];
}

const KEYS = ['a', 'e', 'i', 'node', 'varpi', 'lambda'];
function interpolate(p, q, t) {
  const w = (t - p.t) / (q.t - p.t);
  return Object.fromEntries(KEYS.map((k) => [k, p[k] + (q[k] - p[k]) * w]));
}

/**
 * Running mean over ±`halfWidth` days, for orbits whose osculating elements
 * wobble faster than the sampling step can follow. The eccentricity is
 * averaged as a vector because ϖ is poorly defined on near-circular orbits.
 */
function smooth(rows, halfWidth) {
  return rows.map((r, k) => {
    let h = 0;
    while (k - h > 0 && k + h < rows.length - 1 && rows[k + h + 1].t - r.t <= halfWidth && r.t - rows[k - h - 1].t <= halfWidth) h++;
    const win = rows.slice(k - h, k + h + 1);
    const mean = (f) => win.reduce((sum, x) => sum + f(x), 0) / win.length;
    const ex = mean((x) => x.e * Math.cos(x.varpi * DEG));
    const ey = mean((x) => x.e * Math.sin(x.varpi * DEG));
    const varpi = Math.atan2(ey, ex) / DEG;
    return {
      ...r,
      a: mean((x) => x.a),
      e: Math.hypot(ex, ey),
      i: mean((x) => x.i),
      node: mean((x) => x.node),
      varpi: r.varpi + near(varpi - r.varpi),
      lambda: mean((x) => x.lambda),
    };
  });
}

/**
 * Greedy thinning: keep the fewest epochs such that interpolating between them
 * reproduces every sample (`truth`, which `rows` may be a smoothed copy of)
 * within tolerance.
 */
function thin(rows, tol, tight, truth = rows) {
  const pos = truth.map(position);
  const fits = (i, j) => {
    for (let k = i; k <= j; k++) {
      const p = position(interpolate(rows[i], rows[j], rows[k].t));
      const q = pos[k];
      const limit = Math.hypot(q[0], q[1], q[2]) * (tight(rows[k].t) ? tol / TIGHT : tol) * MARGIN;
      if (Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) > limit) return false;
    }
    return true;
  };
  const keep = [0];
  let i = 0;
  while (i < rows.length - 1) {
    // Neighbouring raw samples always fit; smoothed ones may not, and then this candidate is out.
    if (!fits(i, i + 1)) return null;
    let j = i + 1;
    while (j + 1 < rows.length && fits(i, j + 1)) j++;
    keep.push(j);
    i = j;
  }
  return keep.map((k) => rows[k]);
}

const sig = (x, digits) => Number(x.toPrecision(digits));
const ELEMENT_KEYS = ['a', 'e', 'i', 'node', 'varpi', 'lambda'];

/**
 * Compact form: every column is quantized to an integer grid and delta-coded,
 * and λ is stored as its residual from uniform motion at the mean rate `n`.
 * Quanta follow the tolerance; angles and e are finer for eccentric orbits,
 * where a small error near perihelion is a large fraction of the distance.
 */
function encode(rows, tol, timeQuantum) {
  const first = rows[0];
  const last = rows.at(-1);
  // Mean motion (deg/day), also used to extrapolate past either end.
  const n = rows.length > 1 ? sig((last.lambda - first.lambda) / (last.t - first.t), 12) : sig(first.n, 12);
  const eMax = Math.max(...rows.map((r) => r.e));
  const unit = tol / 20;
  const q = [timeQuantum, sig(first.a * unit, 1), sig(unit * (1 - eMax), 1), sig((unit * (1 - eMax) ** 1.5) / DEG, 1)];
  const ticks = rows.map((r) => Math.round(r.t / q[0]));
  const t0 = ticks[0] * q[0];
  const columns = {
    a: rows.map((r) => r.a / q[1]),
    e: rows.map((r) => r.e / q[2]),
    i: rows.map((r) => r.i / q[3]),
    node: rows.map((r) => r.node / q[3]),
    varpi: rows.map((r) => r.varpi / q[3]),
    // Shift λ to the rounded epoch, then take out the uniform motion.
    lambda: rows.map((r, k) => (r.lambda + r.n * (ticks[k] * q[0] - r.t) - n * (ticks[k] * q[0] - t0)) / q[3]),
  };
  const delta = (xs) => xs.map((x) => Math.round(x)).map((x, k, a) => (k ? x - a[k - 1] : x));
  return { n, q, t: delta(ticks), ...Object.fromEntries(ELEMENT_KEYS.map((key) => [key, delta(columns[key])])) };
}

/** Inverse of `encode` (mirrors seriesAt in src/engine/astro.ts). */
function decode(body) {
  const sum = (xs, unit) => {
    let acc = 0;
    return xs.map((x) => {
      acc += x;
      return acc * unit;
    });
  };
  const t = sum(body.t, body.q[0]);
  const cols = { a: sum(body.a, body.q[1]), e: sum(body.e, body.q[2]) };
  for (const key of ['i', 'node', 'varpi', 'lambda']) cols[key] = sum(body[key], body.q[3]);
  return t.map((tk, k) => ({
    t: tk,
    a: cols.a[k],
    e: cols.e[k],
    i: cols.i[k],
    node: cols.node[k],
    varpi: cols.varpi[k],
    lambda: cols.lambda[k] + body.n * (tk - t[0]),
  }));
}

/** Largest position error of the decoded series over all samples, as a fraction of each sample's limit. */
function verify(body, samples, tol, tight) {
  const knots = decode(body);
  let worst = 0;
  let j = 0;
  for (const s of samples) {
    while (j < knots.length - 2 && knots[j + 1].t <= s.t) j++;
    const p = knots.length > 1 ? position(interpolate(knots[j], knots[j + 1], s.t)) : position(knots[0]);
    const q = position(s);
    const limit = Math.hypot(...q) * (tight(s.t) ? tol / TIGHT : tol);
    const err = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) / limit;
    // NaN (a failed Kepler solve) must count as a miss.
    worst = Number.isNaN(err) ? Infinity : Math.max(worst, err);
  }
  return worst;
}

// Bodies not being refetched are carried over, unless they are still in the old single-epoch format.
const previous = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { bodies: {} };
for (const [id, body] of Object.entries(previous.bodies)) if (!body.q) delete previous.bodies[id];
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const TOL_SCALE = Number(process.env.TOL_SCALE ?? 1);
const only = new Set(args.filter((a) => !a.startsWith('--')));
const result = {
  source: 'NASA/JPL Horizons osculating elements (ecliptic & equinox J2000), sampled 1800–2200 and thinned',
  generated: new Date().toISOString().slice(0, 10),
  bodies: {},
};

const targets = [
  ...Object.entries(PLANETS).map(([id, command]) => ({ def: CATALOG.find((d) => d.id === id), command })),
  ...CATALOG.filter((d) => d.horizons).map((def) => ({ def, command: def.horizons })),
];

for (const { def, command } of targets) {
  if (only.size && !only.has(def.id)) {
    if (previous.bodies[def.id]) result.bodies[def.id] = previous.bodies[def.id];
    continue;
  }
  const center = BARYCENTRIC[def.id] ?? CENTER[def.parent ?? 'sun'];
  const { step, tol: baseTol } = plan(def);
  let tol = baseTol * TOL_SCALE;
  try {
    let rows;
    const windows = [];
    if (SINGLE_EPOCH.has(def.id)) {
      rows = (await elements(command, center, EPOCH, `${EPOCH} 00:01`, '1d')).slice(0, 1);
    } else {
      const nea = def.kind === 'asteroid' && /near-earth/i.test(def.class);
      rows = nea ? await chunkedElements(command, center, `${step}d`) : await elements(command, center, START, STOP, `${step}d`);
      if (nea) {
        const designation = command.replace(/;$/, '');
        const approaches = await closeApproaches(designation);
        for (const jd of approaches) {
          // Hourly for ±3 days, and every 2 minutes for the hours around closest
          // approach, when the heliocentric orbit is being reshaped.
          rows.push(...(await elements(command, center, `JD${(jd - 3).toFixed(4)}`, `JD${(jd + 3).toFixed(4)}`, '1h')));
          rows.push(...(await elements(command, center, `JD${(jd - 1 / 6).toFixed(4)}`, `JD${(jd + 1 / 6).toFixed(4)}`, '2m')));
          windows.push([jd - 3, jd + 3]);
        }
        rows.sort((p, q) => p.t - q.t);
        rows = rows.filter((r, k) => k === 0 || r.t - rows[k - 1].t > 1e-6);
      }
    }
    // A comet passing close to Jupiter is briefly on a hyperbolic heliocentric
    // orbit (Wild 2 in 1974); interpolation bridges those few samples instead.
    const bound = rows.filter((r) => r.e < 1);
    const dropped = rows.length - bound.length;
    const series = unwrap(bound);
    const tight = (t) => windows.some(([a, b]) => t >= a && t <= b);
    // Some moons wobble on a timescale shorter than the sampling step (Jupiter's
    // and Saturn's oblateness, Pluto–Charon's binary pull on Nix and Hydra), so
    // their samples scatter around the mean orbit. For those, also try mean
    // elements, and if that is not enough, raise the tolerance to just above the scatter.
    const moon = def.kind === 'moon';
    const candidates = moon ? [series, smooth(series, 2 * step), smooth(series, 5 * step)] : [series];
    const fewest = (t) =>
      candidates
        .map((c) => thin(c, t, tight, series))
        .filter(Boolean)
        .reduce((best, k) => (k.length < best.length ? k : best));
    let kept = series.length > 1 ? fewest(tol) : series;
    while (moon && series.length > 1 && kept.length > series.length / 8 && tol < baseTol * TOL_SCALE * 16) {
      tol *= 1.5;
      kept = fewest(tol);
    }
    const body = encode(kept, windows.length ? tol / TIGHT : tol, windows.length ? 1e-7 : 1e-4);
    if (MEAN_MOTION[def.id]) body.n = MEAN_MOTION[def.id];
    const worst = verify(body, series, tol, tight);
    if (worst > 1) throw new Error(`encoded series misses a sample by ${worst.toFixed(2)}× the tolerance`);
    result.bodies[def.id] = { center: def.parent ?? 'sun', ...(BARYCENTRIC[def.id] ? { barycentric: true } : {}), ...body };
    const span = `${rows[0].t.toFixed(0)}–${rows.at(-1).t.toFixed(0)}`;
    const kb = (JSON.stringify(result.bodies[def.id]).length / 1024).toFixed(1);
    const notes = [windows.length && `+${windows.length} close approaches`, dropped && `${dropped} unbound samples skipped`]
      .filter(Boolean)
      .join(', ');
    console.log(
      `${def.id.padEnd(12)} ${String(rows.length).padStart(5)} samples → ${String(kept.length).padStart(4)} epochs ${kb.padStart(6)} KB  tol ${tol.toExponential(1)}  err ${worst.toFixed(2)}  JD ${span}${notes ? `  (${notes})` : ''}`,
    );
  } catch (err) {
    console.warn(`!! ${def.id}: ${String(err.message).split('\n').slice(-4).join(' | ')}`);
    if (previous.bodies[def.id]) result.bodies[def.id] = previous.bodies[def.id];
  }
}

if (DRY) process.exit(0);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(result)}\n`);
const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
console.log(`\nwrote ${Object.keys(result.bodies).length} bodies (${kb} KB) → ${path.relative(process.cwd(), OUT)}`);
