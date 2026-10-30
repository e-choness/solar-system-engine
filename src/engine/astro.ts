/**
 * Astronomy core: time scales, reference frames and Keplerian propagation.
 * Everything here runs in float64 and has no three.js dependency so it can be
 * unit-tested in isolation.
 *
 * Frames
 *  - ecliptic: J2000 ecliptic & equinox, km. x → vernal equinox, z → north ecliptic pole.
 *  - scene:    three.js world, Y-up. scene = (x, z, −y) of ecliptic.
 */

export const AU_KM = 149_597_870.7;
export const J2000 = 2_451_545.0;
export const DEG = Math.PI / 180;
/** Obliquity of the ecliptic at J2000 (IAU 1976), radians. */
export const OBLIQUITY = 23.4392911 * DEG;
/** TT − UTC (32.184 s + 37 leap seconds). TDB differs from TT by < 2 ms. */
const TT_MINUS_UTC_DAYS = 69.184 / 86400;

export type Vec3 = [number, number, number];
/** Row-major 3×3 matrix. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

// ───────────────────────────────────────────────────────────── time

export function jdFromDate(date: Date): number {
  return date.getTime() / 86_400_000 + 2_440_587.5 + TT_MINUS_UTC_DAYS;
}

export function dateFromJd(jd: number): Date {
  return new Date((jd - 2_440_587.5 - TT_MINUS_UTC_DAYS) * 86_400_000);
}

// ───────────────────────────────────────────────────────────── vectors & matrices

export const mulMV = (m: Mat3, v: Vec3): Vec3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

export function mulMM(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9).fill(0) as Mat3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
}

export const transpose = (m: Mat3): Mat3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

export function rotX(a: number): Mat3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}

export function rotZ(a: number): Mat3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const length = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export function normalize(a: Vec3): Vec3 {
  const l = length(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

// ───────────────────────────────────────────────────────────── frames

/** Equatorial (ICRF/J2000) → ecliptic J2000. */
export const EQ_TO_ECL: Mat3 = rotX(-OBLIQUITY);

/** Equatorial J2000 → galactic (x → galactic centre, z → north galactic pole). */
export const EQ_TO_GAL: Mat3 = [
  -0.0548755604, -0.8734370902, -0.4838350155, 0.4941094279, -0.44482963, 0.7469822445, -0.867666149, -0.1980763734, 0.4559837762,
];

/** Ecliptic → scene (three.js, Y-up) and its inverse. */
export const ECL_TO_SCENE: Mat3 = [1, 0, 0, 0, 0, 1, 0, -1, 0];
export const SCENE_TO_ECL: Mat3 = transpose(ECL_TO_SCENE);

export const eclToScene = (v: Vec3): Vec3 => [v[0], v[2], -v[1]];

/** Unit vector for an IAU pole given in equatorial RA/Dec (deg), expressed in the ecliptic frame. */
export function poleEcliptic(raDeg: number, decDeg: number): Vec3 {
  const ra = raDeg * DEG;
  const dec = decDeg * DEG;
  return mulMV(EQ_TO_ECL, [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)]);
}

/**
 * IAU body-fixed → ecliptic rotation: x toward the prime meridian, z toward the north pole.
 * M = Rx(−ε) · Rz(α + 90°) · Rx(90° − δ) · Rz(W)
 */
export function iauOrientation(raDeg: number, decDeg: number, wDeg: number): Mat3 {
  return mulMM(EQ_TO_ECL, mulMM(rotZ((raDeg + 90) * DEG), mulMM(rotX((90 - decDeg) * DEG), rotZ(wDeg * DEG))));
}

/** Synchronous rotation: prime meridian faces the parent, pole along the orbit normal. */
export function lockedOrientation(relToParent: Vec3, orbitNormal: Vec3): Mat3 {
  const z = normalize(orbitNormal);
  const toParent: Vec3 = [-relToParent[0], -relToParent[1], -relToParent[2]];
  const y = normalize(cross(z, toParent));
  const x = cross(y, z);
  // Columns are the body axes in ecliptic coordinates.
  return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
}

/** Converts an ecliptic-frame rotation into the scene frame (S · M · Sᵀ). */
export const toSceneRotation = (m: Mat3): Mat3 => mulMM(ECL_TO_SCENE, mulMM(m, SCENE_TO_ECL));

// ───────────────────────────────────────────────────────────── Kepler

/** Osculating / mean elements. Angles in degrees, a in km, rates per day. */
export interface Elements {
  a: number;
  e: number;
  i: number;
  /** Longitude of ascending node Ω. */
  node: number;
  /** Argument of periapsis ω. */
  peri: number;
  /** Mean anomaly at epoch. */
  M: number;
  epoch: number;
  /** Mean motion (deg/day). */
  n: number;
  nodeRate?: number;
  /** Rate of the longitude of periapsis ϖ = Ω + ω (deg/day). */
  periRate?: number;
}

export interface Snapshot {
  a: number;
  e: number;
  i: number;
  node: number;
  peri: number;
  M: number;
}

export const wrap360 = (d: number) => ((d % 360) + 360) % 360;

/** Mean elements at `jd`, applying mean motion and secular precession. */
export function elementsAt(el: Elements, jd: number): Snapshot {
  const dt = jd - el.epoch;
  const node = el.node + (el.nodeRate ?? 0) * dt;
  const varpi = el.node + el.peri + (el.periRate ?? 0) * dt;
  const lambda = el.node + el.peri + el.M + el.n * dt;
  return { a: el.a, e: el.e, i: el.i, node, peri: varpi - node, M: wrap360(lambda - varpi) };
}

/** Solves Kepler's equation M = E − e·sin E (radians). */
export function eccentricAnomaly(M: number, e: number): number {
  let m = M % (2 * Math.PI);
  if (m > Math.PI) m -= 2 * Math.PI;
  else if (m < -Math.PI) m += 2 * Math.PI;
  let E = e < 0.8 ? m : Math.PI * Math.sign(m || 1);
  for (let k = 0; k < 50; k++) {
    const f = E - e * Math.sin(E) - m;
    const d = f / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-13) break;
  }
  return E;
}

/** Perifocal → ecliptic rotation for a snapshot (Rz(Ω) · Rx(i) · Rz(ω)). */
export function orbitRotation(s: Snapshot): Mat3 {
  return mulMM(rotZ(s.node * DEG), mulMM(rotX(s.i * DEG), rotZ(s.peri * DEG)));
}

/** Orbit normal in ecliptic coordinates. */
export function orbitNormal(s: Snapshot): Vec3 {
  const i = s.i * DEG;
  const o = s.node * DEG;
  return [Math.sin(i) * Math.sin(o), -Math.sin(i) * Math.cos(o), Math.cos(i)];
}

/** Position relative to the central body in ecliptic km. */
export function positionFromSnapshot(s: Snapshot): Vec3 {
  const E = eccentricAnomaly(s.M * DEG, s.e);
  const xp = s.a * (Math.cos(E) - s.e);
  const yp = s.a * Math.sqrt(1 - s.e * s.e) * Math.sin(E);
  return mulMV(orbitRotation(s), [xp, yp, 0]);
}

/**
 * Samples a closed orbit ellipse relative to its central body, denser near
 * periapsis so very eccentric comet orbits stay smooth. Returns ecliptic km.
 */
export function sampleOrbit(s: Snapshot, segments: number): Float64Array {
  const out = new Float64Array((segments + 1) * 3);
  const r = orbitRotation(s);
  const b = s.a * Math.sqrt(1 - s.e * s.e);
  const bias = s.e > 0.5 ? 1.8 : 1;
  for (let k = 0; k <= segments; k++) {
    const t = (k / segments) * 2 - 1;
    const E = Math.PI * Math.sign(t) * Math.abs(t) ** bias;
    const p = mulMV(r, [s.a * (Math.cos(E) - s.e), b * Math.sin(E), 0]);
    out.set(p, k * 3);
  }
  return out;
}

/** Orbital period in days from mean motion. */
export const periodDays = (el: Elements) => 360 / Math.abs(el.n);
