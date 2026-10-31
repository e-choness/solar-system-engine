import { describe, expect, it } from 'vitest';
import {
  AU_KM,
  DEG,
  dateFromJd,
  decodeSeries,
  dot,
  type EncodedSeries,
  EQ_TO_GAL,
  eccentricAnomaly,
  elementsFromState,
  INVARIABLE_POLE,
  iauOrientation,
  J2000,
  jdFromDate,
  length,
  mulMM,
  normalize,
  OBLIQUITY,
  orbitAnomalies,
  orbitNormal,
  poleEcliptic,
  positionFromSnapshot,
  sampleOrbit,
  seriesAt,
  transpose,
  type Vec3,
} from '../src/engine/astro.ts';
import { moonPosition } from '../src/engine/moon.ts';
import { planetSnapshot, SolarSystem } from '../src/engine/system.ts';

const angleDeg = (a: Vec3, b: Vec3) => Math.acos(Math.min(1, Math.max(-1, dot(normalize(a), normalize(b))))) / DEG;

describe('time', () => {
  it('maps J2000 noon to JD 2451545 (TT)', () => {
    const jd = jdFromDate(new Date('2000-01-01T12:00:00Z'));
    expect(jd - J2000).toBeCloseTo(69.184 / 86400, 9);
  });

  it('round-trips dates', () => {
    const d = new Date('2026-10-29T22:00:00Z');
    expect(dateFromJd(jdFromDate(d)).getTime()).toBeCloseTo(d.getTime(), -1);
  });
});

describe('Kepler solver', () => {
  it('satisfies M = E − e sin E across eccentricities', () => {
    for (const e of [0, 0.0167, 0.2, 0.6, 0.9, 0.967, 0.995]) {
      for (let M = -3; M <= 3; M += 0.37) {
        const E = eccentricAnomaly(M, e);
        expect(E - e * Math.sin(E)).toBeCloseTo(M, 9);
      }
    }
  });

  it('samples a closed ellipse that passes through periapsis', () => {
    const s = { a: 1000, e: 0.9, i: 10, node: 30, peri: 40, M: 0 };
    const pts = sampleOrbit(s, 256);
    const first = [pts[0], pts[1], pts[2]];
    const last = [pts.at(-3)!, pts.at(-2)!, pts.at(-1)!];
    first.forEach((v, k) => {
      expect(v).toBeCloseTo(last[k], 6);
    });
    const peri = positionFromSnapshot(s);
    expect(length(peri)).toBeCloseTo(1000 * (1 - 0.9), 6);
  });
});

describe('orbits', () => {
  it('samples orbit lines with the body on a vertex and the loop closed', () => {
    const out = new Float64Array(1024);
    for (const [e, E0] of [
      [0.01, 0.3],
      [0.97, 3.1],
      [0.5, -2],
    ]) {
      const n = orbitAnomalies(e, E0, 512, 256, Math.PI / 6, out);
      const d = out.subarray(0, n);
      expect(d).toContain(0);
      expect(d[n - 1] - d[0]).toBeCloseTo(2 * Math.PI, 12);
      for (let k = 1; k < n; k++) expect(d[k]).toBeGreaterThan(d[k - 1]);
    }
  });

  it('recovers elements from a state vector', () => {
    const mu = 1.32712440018e11 * 86400 ** 2;
    const s = { a: 2.2e8, e: 0.3, i: 12, node: 80, peri: 250, M: 40 };
    const n = Math.sqrt(mu / s.a ** 3) / DEG;
    const h = 1e-3;
    const p = positionFromSnapshot(s);
    const a = positionFromSnapshot({ ...s, M: s.M - n * h });
    const b = positionFromSnapshot({ ...s, M: s.M + n * h });
    const v: Vec3 = [(b[0] - a[0]) / (2 * h), (b[1] - a[1]) / (2 * h), (b[2] - a[2]) / (2 * h)];
    const r = elementsFromState(p, v, mu);
    expect(r.a / s.a).toBeCloseTo(1, 6);
    expect(r.e).toBeCloseTo(s.e, 6);
    for (const k of ['i', 'node', 'peri', 'M'] as const) expect(r[k]).toBeCloseTo(s[k], 4);
  });

  it('interpolates element series and keeps the mean motion past the ends', () => {
    // Two epochs 100 days apart: a 1000 → 1100 km, λ residual 0 → 10°, n = 1°/day.
    const enc: EncodedSeries = {
      n: 1,
      q: [1e-4, 1, 1e-6, 1e-3],
      t: [24515450000, 1000000],
      a: [1000, 100],
      e: [100000, 0],
      i: [0, 0],
      node: [0, 0],
      varpi: [0, 0],
      lambda: [0, 10000],
    };
    const s = decodeSeries(enc);
    const mid = seriesAt(s, J2000 + 50);
    expect(mid.a).toBeCloseTo(1050, 9);
    expect(mid.M).toBeCloseTo(55, 9);
    expect(seriesAt(s, J2000 + 130).M).toBeCloseTo((110 + 30) % 360, 9);
    expect(seriesAt(s, J2000 - 20).M).toBeCloseTo(340, 9);
  });
});

describe('frames', () => {
  it('puts Earth’s north pole at the obliquity from the ecliptic pole', () => {
    const pole = poleEcliptic(0, 90);
    expect(angleDeg(pole, [0, 0, 1])).toBeCloseTo(OBLIQUITY / DEG, 6);
  });

  it('IAU orientation has the pole as its third column', () => {
    const m = iauOrientation(40.589, 83.537, 123);
    const z: Vec3 = [m[2], m[5], m[8]];
    const pole = poleEcliptic(40.589, 83.537);
    expect(angleDeg(z, pole)).toBeLessThan(1e-9);
  });

  it('reproduces planetary obliquities from IAU poles and JPL orbits', () => {
    const jd = J2000;
    const tilt = (id: string, ra: number, dec: number) => angleDeg(poleEcliptic(ra, dec), orbitNormal(planetSnapshot(id, jd)!));
    expect(tilt('earth', 0, 90)).toBeCloseTo(23.44, 1);
    expect(tilt('saturn', 40.589, 83.537)).toBeCloseTo(26.73, 1);
    // IAU "north" lies on the north side of the invariable plane; Uranus spins retrograde about it.
    expect(180 - tilt('uranus', 257.311, -15.175)).toBeCloseTo(97.77, 1);
    expect(tilt('mars', 317.68143, 52.8865)).toBeCloseTo(25.19, 1);
  });

  it('galactic rotation is orthonormal', () => {
    const id = mulMM(EQ_TO_GAL, transpose(EQ_TO_GAL));
    [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, k) => {
      expect(id[k]).toBeCloseTo(v, 8);
    });
  });
});

describe('solar system ephemeris', () => {
  const sys = new SolarSystem();

  it('places Earth near (−0.177, 0.967) AU at J2000', () => {
    sys.update(J2000);
    const e = sys.get('earth')!.pos;
    expect(e[0] / AU_KM).toBeCloseTo(-0.177, 2);
    expect(e[1] / AU_KM).toBeCloseTo(0.967, 2);
  });

  it('matches the March 2026 equinox once J2000 precession is accounted for', () => {
    const jd = jdFromDate(new Date('2026-03-20T14:46:00Z'));
    sys.update(jd);
    const e = sys.get('earth')!.pos;
    const sunLonJ2000 = Math.atan2(-e[1], -e[0]) / DEG;
    // The equinox of date has precessed ~50.29″/yr ahead of the J2000 equinox.
    const precession = (50.29 / 3600) * ((jd - J2000) / 365.25);
    expect(sunLonJ2000 + precession).toBeCloseTo(0, 1);
  });

  it('keeps moons at plausible distances from their planets', () => {
    sys.update(jdFromDate(new Date('2026-11-15T00:00:00Z')));
    const dist = (a: string, b: string) => {
      const p = sys.get(a)!.pos;
      const q = sys.get(b)!.pos;
      return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    };
    expect(dist('moon', 'earth')).toBeGreaterThan(356_000);
    expect(dist('moon', 'earth')).toBeLessThan(407_000);
    expect(dist('io', 'jupiter')).toBeCloseTo(421_800, -4);
    expect(dist('titan', 'saturn')).toBeCloseTo(1_221_870, -5);
    expect(dist('charon', 'pluto')).toBeCloseTo(19_596, -2);
  });

  it('follows the lunar theory (Meeus example 47.a)', () => {
    // 1992 April 12, 0h TD: λ = 133.162655°, β = −3.229126° (mean equinox of date), Δ = 368409.7 km.
    const r = moonPosition(2448724.5);
    expect(length(r)).toBeCloseTo(368409.7, 0);
    const precession = (50.29 / 3600) * ((2448724.5 - J2000) / 365.25);
    expect(Math.atan2(r[1], r[0]) / DEG).toBeCloseTo(133.162655 - precession, 2);
    expect(Math.asin(r[2] / length(r)) / DEG).toBeCloseTo(-3.229126, 2);
  });

  it('shows the 2020 great conjunction: Jupiter 6.1′ from Saturn', () => {
    sys.update(jdFromDate(new Date('2020-12-21T18:30:00Z')));
    const e = sys.get('earth')!.pos;
    const from = (id: string): Vec3 => {
      const p = sys.get(id)!.pos;
      return [p[0] - e[0], p[1] - e[1], p[2] - e[2]];
    };
    expect(angleDeg(from('jupiter'), from('saturn')) * 60).toBeCloseTo(6.1, 0);
  });

  it('flies Apophis past Earth at ~38,000 km on 2029 April 13', () => {
    let closest = Infinity;
    const t0 = jdFromDate(new Date('2029-04-13T21:46:00Z'));
    for (let m = -120; m <= 120; m += 2) {
      sys.update(t0 + m / 1440);
      const p = sys.get('apophis')!.pos;
      const q = sys.get('earth')!.pos;
      closest = Math.min(closest, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
    }
    expect(closest).toBeGreaterThan(37_000);
    expect(closest).toBeLessThan(39_000);
  });

  it('puts IAU north of retrograde and Uranian moons on the invariable plane’s north side', () => {
    sys.update(jdFromDate(new Date('2026-12-01T00:00:00Z')));
    for (const id of ['triton', 'ariel', 'titan', 'io']) {
      const m = sys.get(id)!.rotation;
      expect(dot([m[2], m[5], m[8]], INVARIABLE_POLE)).toBeGreaterThan(0);
    }
  });

  it('keeps tidally locked moons facing their planet', () => {
    sys.update(jdFromDate(new Date('2026-12-01T00:00:00Z')));
    const moon = sys.get('moon')!;
    const x: Vec3 = [moon.rotation[0], moon.rotation[3], moon.rotation[6]];
    const toEarth: Vec3 = [-moon.rel[0], -moon.rel[1], -moon.rel[2]];
    expect(angleDeg(x, toEarth)).toBeLessThan(0.01);
  });

  it('reports Earth’s orbital speed near 29.8 km/s', () => {
    sys.update(J2000 + 100);
    const v = length(sys.get('earth')!.vel) / 86400;
    expect(v).toBeGreaterThan(29);
    expect(v).toBeLessThan(30.7);
  });
});
