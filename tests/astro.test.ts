import { describe, expect, it } from 'vitest';
import {
  AU_KM,
  DEG,
  dateFromJd,
  dot,
  EQ_TO_GAL,
  eccentricAnomaly,
  iauOrientation,
  J2000,
  jdFromDate,
  length,
  mulMM,
  normalize,
  OBLIQUITY,
  orbitNormal,
  poleEcliptic,
  positionFromSnapshot,
  sampleOrbit,
  transpose,
  type Vec3,
} from '../src/engine/astro.ts';
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
