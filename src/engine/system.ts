import { BODY_BY_ID, CATALOG } from '../data/catalog.ts';
import ephemeris from '../data/generated/ephemeris.json' with { type: 'json' };
import { PLANET_ELEMENTS } from '../data/planet-elements.ts';
import type { BodyDef } from '../data/types.ts';
import {
  AU_KM,
  DEG,
  decodeSeries,
  dot,
  type ElementSeries,
  type EncodedSeries,
  elementsFromState,
  INVARIABLE_POLE,
  iauOrientation,
  J2000,
  lockedOrientation,
  type Mat3,
  mulMM,
  orbitNormal,
  positionFromSnapshot,
  rotZ,
  type Snapshot,
  seriesAt,
  type Vec3,
} from './astro.ts';
import { moonPosition } from './moon.ts';

interface EphemerisEntry extends ElementSeries {
  center: string;
  barycentric?: boolean;
}
const EPHEMERIS: Record<string, EphemerisEntry> = Object.fromEntries(
  Object.entries(
    (ephemeris as unknown as { bodies: Record<string, EncodedSeries & { center: string; barycentric?: boolean }> }).bodies,
  ).map(([id, s]) => [id, { center: s.center, barycentric: s.barycentric, ...decodeSeries(s) }]),
);

/** GM of the Earth + Moon (km³/s²), in km³/day². */
const MU_EARTH_MOON = 403503.235 * 86400 ** 2;

/** Osculating orbit of the Moon around the Earth from the lunar theory (src/engine/moon.ts). */
function moonSnapshot(jd: number): Snapshot {
  const h = 0.01;
  const a = moonPosition(jd - h);
  const b = moonPosition(jd + h);
  const v: Vec3 = [(b[0] - a[0]) / (2 * h), (b[1] - a[1]) / (2 * h), (b[2] - a[2]) / (2 * h)];
  return elementsFromState(moonPosition(jd), v, MU_EARTH_MOON);
}

/** Mean elements of a planet (or Pluto) from the JPL approximate-position table. */
export function planetSnapshot(id: string, jd: number): Snapshot | null {
  const p = PLANET_ELEMENTS[id];
  if (!p) return null;
  const T = (jd - J2000) / 36525;
  const node = p.node[0] + p.node[1] * T;
  const varpi = p.peri[0] + p.peri[1] * T;
  const L = p.L[0] + p.L[1] * T;
  return {
    a: (p.a[0] + p.a[1] * T) * AU_KM,
    e: p.e[0] + p.e[1] * T,
    i: p.i[0] + p.i[1] * T,
    node,
    peri: varpi - node,
    M: L - varpi,
  };
}

/** Mean orbital (sidereal) period in days for any body with an orbit. */
export function orbitalPeriodDays(id: string): number | null {
  const e = EPHEMERIS[id];
  if (e) return 360 / Math.abs(e.n);
  const p = PLANET_ELEMENTS[id];
  return p ? (360 / p.L[1]) * 36525 : null;
}

export class BodyState {
  readonly def: BodyDef;
  readonly index: number;
  parent: BodyState | null = null;
  readonly children: BodyState[] = [];
  /** Heliocentric ecliptic position (km). */
  readonly pos: Vec3 = [0, 0, 0];
  /** Position relative to the orbit's centre (km). */
  readonly rel: Vec3 = [0, 0, 0];
  /** Heliocentric velocity (km/day), finite-differenced. */
  readonly vel: Vec3 = [0, 0, 0];
  /** Current orbit, relative to `orbitCenter()`. */
  snapshot: Snapshot | null = null;
  /** Body-fixed → ecliptic rotation. */
  rotation: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  /** Barycentre of a primary + large moon pair (Earth–Moon, Pluto–Charon). */
  readonly bary: Vec3 = [0, 0, 0];
  readonly ephemeris: EphemerisEntry | null;
  /** Largest moon for barycentric primaries. */
  partner: BodyState | null = null;

  constructor(def: BodyDef, index: number) {
    this.def = def;
    this.index = index;
    this.ephemeris = EPHEMERIS[def.id] ?? null;
  }

  get radius() {
    return this.def.physical.radius;
  }

  /** Heliocentric position of the point the orbit is drawn around. */
  orbitCenter(): Vec3 {
    if (!this.parent) return [0, 0, 0];
    if (this.ephemeris?.barycentric || this.parent.partner === this) return this.parent.bary;
    return this.parent.pos;
  }

  /** Orbital elements usable for drawing (null for the Sun). */
  orbitElements(jd: number): Snapshot | null {
    if (this.def.id === 'moon') return moonSnapshot(jd);
    return this.ephemeris ? seriesAt(this.ephemeris, jd) : planetSnapshot(this.def.id, jd);
  }
}

export class SolarSystem {
  readonly bodies: BodyState[];
  readonly byId = new Map<string, BodyState>();
  jd = J2000;
  private readonly ahead: Float64Array;

  constructor() {
    this.bodies = CATALOG.filter((d) => d.kind === 'star' || PLANET_ELEMENTS[d.id] || EPHEMERIS[d.id]).map((d, i) => new BodyState(d, i));
    for (const b of this.bodies) this.byId.set(b.def.id, b);
    for (const b of this.bodies) {
      if (!b.def.parent) continue;
      b.parent = this.byId.get(b.def.parent) ?? null;
      b.parent?.children.push(b);
    }
    for (const b of this.bodies) {
      if (b.def.baryShare) {
        b.partner = b.children.reduce<BodyState | null>(
          (best, c) => ((c.def.physical.mass ?? 0) > (best?.def.physical.mass ?? 0) ? c : best),
          null,
        );
      }
    }
    // Parents before children so positions can be accumulated in one pass.
    const depth = (b: BodyState): number => (b.parent ? depth(b.parent) + 1 : 0);
    this.bodies.sort((a, b) => depth(a) - depth(b));
    this.ahead = new Float64Array(this.bodies.length * 3);
  }

  get(id: string): BodyState | undefined {
    return this.byId.get(id);
  }

  update(jd: number) {
    // Velocity by central-ish difference: solve slightly ahead, then at jd.
    const h = 0.005;
    this.place(jd + h);
    for (const b of this.bodies) this.ahead.set(b.pos, b.index * 3);
    this.place(jd);
    for (const b of this.bodies) for (let k = 0; k < 3; k++) b.vel[k] = (this.ahead[b.index * 3 + k] - b.pos[k]) / h;
    for (const b of this.bodies) b.rotation = this.orientation(b, jd);
    this.jd = jd;
  }

  private place(jd: number) {
    for (const b of this.bodies) {
      if (!b.parent) continue;
      if (b === b.parent.partner) continue; // placed together with its primary
      b.snapshot = b.orbitElements(jd);
      if (!b.snapshot) continue;
      const r = positionFromSnapshot(b.snapshot);
      for (let k = 0; k < 3; k++) b.rel[k] = r[k];
      if (b.parent.def.kind === 'star') {
        for (let k = 0; k < 3; k++) b.pos[k] = r[k];
        if (b.partner) this.applyBarycentre(b, jd);
      } else {
        const c = b.orbitCenter();
        for (let k = 0; k < 3; k++) b.pos[k] = c[k] + r[k];
      }
    }
  }

  /** Splits a barycentric orbit into primary + partner positions. */
  private applyBarycentre(primary: BodyState, jd: number) {
    const partner = primary.partner!;
    const share = primary.def.baryShare!;
    for (let k = 0; k < 3; k++) primary.bary[k] = primary.pos[k];
    partner.snapshot = partner.orbitElements(jd);
    if (!partner.snapshot) return;
    const r = positionFromSnapshot(partner.snapshot);
    for (let k = 0; k < 3; k++) {
      partner.rel[k] = r[k];
      primary.pos[k] = primary.bary[k] - share * r[k];
      partner.pos[k] = primary.pos[k] + r[k];
    }
  }

  private orientation(b: BodyState, jd: number): Mat3 {
    const d = b.def;
    let m: Mat3;
    if (d.tidallyLocked && b.snapshot) {
      // IAU north for a planet's satellite is on the north side of the invariable
      // plane, so moons circling "backwards" (Triton, and Uranus's moons, which
      // follow its retrograde spin) have north opposite their orbit normal.
      // Dwarf-planet systems (Pluto–Charon) use the right-hand pole instead.
      const n = orbitNormal(b.snapshot);
      const flip = b.parent?.def.kind === 'planet' && dot(n, INVARIABLE_POLE) < 0;
      m = lockedOrientation(b.rel, flip ? [-n[0], -n[1], -n[2]] : n);
    } else if (d.rotation) {
      const w = d.rotation.w0 + d.rotation.wDot * (jd - J2000);
      m = iauOrientation(d.rotation.ra, d.rotation.dec, w);
    } else {
      m = iauOrientation(270, 66.5607, 0);
    }
    const off = d.visual.mapLonOffset ?? 0;
    return off ? mulMM(m, rotZ(off * DEG)) : m;
  }
}

export { BODY_BY_ID };
