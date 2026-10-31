/**
 * Geocentric position of the Moon from the truncated ELP-2000/82 series in
 * J. Meeus, "Astronomical Algorithms" (2nd ed.), chapter 47: about 10″ in
 * longitude and 4″ in latitude, far better than any fixed Keplerian orbit,
 * which drifts by degrees within months because of the Sun's pull.
 */
import { DEG, EQ_TO_ECL, J2000, type Mat3, mulMM, mulMV, rotX, rotZ, transpose, type Vec3 } from './astro.ts';

// Rows: D, M, M′, F multipliers; Σl (1e-6°); Σr (1e-3 km). Table 47.A.
// biome-ignore format: tabular data
const LR: number[] = [
  0, 0, 1, 0, 6288774, -20905355,   2, 0, -1, 0, 1274027, -3699111,   2, 0, 0, 0, 658314, -2955968,
  0, 0, 2, 0, 213618, -569925,      0, 1, 0, 0, -185116, 48888,       0, 0, 0, 2, -114332, -3149,
  2, 0, -2, 0, 58793, 246158,       2, -1, -1, 0, 57066, -152138,     2, 0, 1, 0, 53322, -170733,
  2, -1, 0, 0, 45758, -204586,      0, 1, -1, 0, -40923, -129620,     1, 0, 0, 0, -34720, 108743,
  0, 1, 1, 0, -30383, 104755,       2, 0, 0, -2, 15327, 10321,        0, 0, 1, 2, -12528, 0,
  0, 0, 1, -2, 10980, 79661,        4, 0, -1, 0, 10675, -34782,       0, 0, 3, 0, 10034, -23210,
  4, 0, -2, 0, 8548, -21636,        2, 1, -1, 0, -7888, 24208,        2, 1, 0, 0, -6766, 30824,
  1, 0, -1, 0, -5163, -8379,        1, 1, 0, 0, 4987, -16675,         2, -1, 1, 0, 4036, -12831,
  2, 0, 2, 0, 3994, -10445,         4, 0, 0, 0, 3861, -11650,         2, 0, -3, 0, 3665, 14403,
  0, 1, -2, 0, -2689, -7003,        2, 0, -1, 2, -2602, 0,            2, -1, -2, 0, 2390, 10056,
  1, 0, 1, 0, -2348, 6322,          2, -2, 0, 0, 2236, -9884,         0, 1, 2, 0, -2120, 5751,
  0, 2, 0, 0, -2069, 0,             2, -2, -1, 0, 2048, -4950,        2, 0, 1, -2, -1773, 4130,
  2, 0, 0, 2, -1595, 0,             4, -1, -1, 0, 1215, -3958,        0, 0, 2, 2, -1110, 0,
  3, 0, -1, 0, -892, 3258,          2, 1, 1, 0, -810, 2616,           4, -1, -2, 0, 759, -1897,
  0, 2, -1, 0, -713, -2117,         2, 2, -1, 0, -700, 2354,          2, 1, -2, 0, 691, 0,
  2, -1, 0, -2, 596, 0,             4, 0, 1, 0, 549, -1423,           0, 0, 4, 0, 537, -1117,
  4, -1, 0, 0, 520, -1571,          1, 0, -2, 0, -487, -1739,         2, 1, 0, -2, -399, 0,
  0, 0, 2, -2, -381, -4421,         1, 1, 1, 0, 351, 0,               3, 0, -2, 0, -340, 0,
  4, 0, -3, 0, 330, 0,              2, -1, 2, 0, 327, 0,              0, 2, 1, 0, -323, 1165,
  1, 1, -1, 0, 299, 0,              2, 0, 3, 0, 294, 0,               2, 0, -1, -2, 0, 8752,
];

// Rows: D, M, M′, F multipliers; Σb (1e-6°). Table 47.B.
// biome-ignore format: tabular data
const B: number[] = [
  0, 0, 0, 1, 5128122,   0, 0, 1, 1, 280602,    0, 0, 1, -1, 277693,   2, 0, 0, -1, 173237,
  2, 0, -1, 1, 55413,    2, 0, -1, -1, 46271,   2, 0, 0, 1, 32573,     0, 0, 2, 1, 17198,
  2, 0, 1, -1, 9266,     0, 0, 2, -1, 8822,     2, -1, 0, -1, 8216,    2, 0, -2, -1, 4324,
  2, 0, 1, 1, 4200,      2, 1, 0, -1, -3359,    2, -1, -1, 1, 2463,    2, -1, 0, 1, 2211,
  2, -1, -1, -1, 2065,   0, 1, -1, -1, -1870,   4, 0, -1, -1, 1828,    0, 1, 0, 1, -1794,
  0, 0, 0, 3, -1749,     0, 1, -1, 1, -1565,    1, 0, 0, 1, -1491,     0, 1, 1, 1, -1475,
  0, 1, 1, -1, -1410,    0, 1, 0, -1, -1344,    1, 0, 0, -1, -1335,    0, 0, 3, 1, 1107,
  4, 0, 0, -1, 1021,     4, 0, -1, 1, 833,      0, 0, 1, -3, 777,      4, 0, -2, 1, 671,
  2, 0, 0, -3, 607,      2, 0, 2, -1, 596,      2, -1, 1, -1, 491,     2, 0, -2, 1, -451,
  0, 0, 3, -1, 439,      2, 0, 2, 1, 422,       2, 0, -3, -1, 421,     2, 1, -1, 1, -366,
  2, 1, 0, 1, -351,      4, 0, 0, 1, 331,       2, -1, 1, 1, 315,      2, -2, 0, -1, 302,
  0, 0, 1, 3, -283,      2, 1, 1, -1, -229,     1, 1, 0, -1, 223,      1, 1, 0, 1, 223,
  0, 1, -2, -1, -220,    2, 1, -1, -1, -220,    1, 0, 1, 1, -185,      2, -1, -2, -1, 181,
  0, 1, 2, 1, -177,      4, 0, -2, -1, 176,     4, -1, -1, -1, 166,    1, 0, 1, -1, -164,
  4, 0, 1, -1, 132,      1, 0, -1, -1, -119,    4, -1, 0, -1, 115,     2, -2, 0, 1, 107,
];

const AS = DEG / 3600;

/** Mean ecliptic & equinox of date → ecliptic J2000 (IAU 1976 precession). */
function dateToJ2000(T: number): Mat3 {
  const zeta = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T ** 3) * AS;
  const z = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T ** 3) * AS;
  const theta = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T ** 3) * AS;
  const eps = (84381.448 - 46.815 * T - 0.00059 * T * T + 0.001813 * T ** 3) * AS;
  // Equatorial J2000 → equatorial of date, P = R₃(−z)·R₂(θ)·R₃(−ζ) in passive rotations
  // (R₃(−φ) is rotZ(φ) here; R₂(θ) is written out).
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const r2: Mat3 = [c, 0, -s, 0, 1, 0, s, 0, c];
  const precess = mulMM(rotZ(z), mulMM(r2, rotZ(zeta)));
  return mulMM(EQ_TO_ECL, mulMM(transpose(precess), rotX(eps)));
}

/** Geocentric Moon vector (km) in the J2000 ecliptic frame at Julian date `jd` (TT). */
export function moonPosition(jd: number): Vec3 {
  const T = (jd - J2000) / 36525;
  const T2 = T * T;
  const T3 = T2 * T;
  const T4 = T3 * T;
  const Lp = (218.3164477 + 481267.88123421 * T - 0.0015786 * T2 + T3 / 538841 - T4 / 65194000) * DEG;
  const D = (297.8501921 + 445267.1114034 * T - 0.0018819 * T2 + T3 / 545868 - T4 / 113065000) * DEG;
  const M = (357.5291092 + 35999.0502909 * T - 0.0001536 * T2 + T3 / 24490000) * DEG;
  const Mp = (134.9633964 + 477198.8675055 * T + 0.0087414 * T2 + T3 / 69699 - T4 / 14712000) * DEG;
  const F = (93.272095 + 483202.0175233 * T - 0.0036539 * T2 - T3 / 3526000 + T4 / 863310000) * DEG;
  const A1 = (119.75 + 131.849 * T) * DEG;
  const A2 = (53.09 + 479264.29 * T) * DEG;
  const A3 = (313.45 + 481266.484 * T) * DEG;
  // Terms in M are scaled by the decreasing eccentricity of Earth's orbit.
  const E = 1 - 0.002516 * T - 0.0000074 * T2;
  const ecc = (m: number) => (m === 0 ? 1 : Math.abs(m) === 1 ? E : E * E);

  let sl = 0;
  let sr = 0;
  for (let k = 0; k < LR.length; k += 6) {
    const arg = LR[k] * D + LR[k + 1] * M + LR[k + 2] * Mp + LR[k + 3] * F;
    const f = ecc(LR[k + 1]);
    sl += LR[k + 4] * f * Math.sin(arg);
    sr += LR[k + 5] * f * Math.cos(arg);
  }
  let sb = 0;
  for (let k = 0; k < B.length; k += 5) {
    const arg = B[k] * D + B[k + 1] * M + B[k + 2] * Mp + B[k + 3] * F;
    sb += B[k + 4] * ecc(B[k + 1]) * Math.sin(arg);
  }
  // Additive terms for Venus (A1), Jupiter (A2) and the flattening of the Earth (L′).
  sl += 3958 * Math.sin(A1) + 1962 * Math.sin(Lp - F) + 318 * Math.sin(A2);
  sb +=
    -2235 * Math.sin(Lp) +
    382 * Math.sin(A3) +
    175 * Math.sin(A1 - F) +
    175 * Math.sin(A1 + F) +
    127 * Math.sin(Lp - Mp) -
    115 * Math.sin(Lp + Mp);

  const lon = Lp + sl * 1e-6 * DEG;
  const lat = sb * 1e-6 * DEG;
  const dist = 385000.56 + sr / 1000;
  const v: Vec3 = [dist * Math.cos(lat) * Math.cos(lon), dist * Math.cos(lat) * Math.sin(lon), dist * Math.sin(lat)];
  return mulMV(dateToJ2000(T), v);
}
