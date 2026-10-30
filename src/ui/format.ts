import { CATALOG } from '../data/catalog.ts';
import type { BodyDef } from '../data/types.ts';
import { AU_KM } from '../engine/astro.ts';
import { orbitalPeriodDays } from '../engine/system.ts';

const G = 6.6743e-11;
const EARTH_MASS = 5.9722e24;
const LY_KM = 9.4607e12;
const SUP: Record<string, string> = {
  '-': '⁻',
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
};

const nf = (digits: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
const n0 = nf(0);

/** 3 significant figures, e.g. 1.23, 45.6, 789. */
export function sig(x: number, s = 3): string {
  if (!Number.isFinite(x)) return '—';
  if (x === 0) return '0';
  const d = Math.max(0, s - 1 - Math.floor(Math.log10(Math.abs(x))));
  return nf(Math.min(d, 6)).format(x);
}

export function sci(x: number, digits = 2): string {
  const e = Math.floor(Math.log10(Math.abs(x)));
  const m = x / 10 ** e;
  return `${m.toFixed(digits)} × 10${String(e)
    .split('')
    .map((c) => SUP[c] ?? c)
    .join('')}`;
}

export function distance(km: number): { value: string; unit: string } {
  if (km < 1) return { value: n0.format(km * 1000), unit: 'm' };
  if (km < 0.05 * AU_KM) return { value: n0.format(km), unit: 'km' };
  if (km < 30000 * AU_KM) return { value: sig(km / AU_KM, 4), unit: 'AU' };
  return { value: sig(km / LY_KM, 3), unit: 'ly' };
}

export const distanceText = (km: number) => {
  const d = distance(km);
  return `${d.value} ${d.unit}`;
};

export function duration(hours: number): string {
  const h = Math.abs(hours);
  const sign = hours < 0 ? ' (retrograde)' : '';
  if (h < 48) {
    const hh = Math.floor(h);
    const mm = Math.round((h - hh) * 60);
    return `${hh} h ${mm} min${sign}`;
  }
  const days = h / 24;
  if (days < 1500) return `${sig(days, 4)} days${sign}`;
  return `${sig(days / 365.25, 4)} years${sign}`;
}

export function mass(kg?: number): string {
  if (!kg) return '—';
  const rel = kg / EARTH_MASS;
  if (rel >= 0.001) return `${sig(rel, 3)} M⊕`;
  return `${sci(kg)} kg`;
}

export function temperature(k?: number, range?: string): string {
  if (range) return range;
  if (!k) return '—';
  return `${n0.format(k - 273.15)} °C`;
}

export interface Derived {
  gravity?: number;
  escape?: number;
  density?: number;
  periodDays: number | null;
  moons: number;
}

export function bodyStats(def: BodyDef): Derived {
  const m = def.physical.mass;
  const r = def.physical.radius * 1000;
  const modelled = CATALOG.filter((b) => b.parent === def.id && b.kind === 'moon').length;
  return {
    gravity: m ? (G * m) / (r * r) : undefined,
    escape: m ? Math.sqrt((2 * G * m) / r) / 1000 : undefined,
    density: m ? m / ((4 / 3) * Math.PI * r ** 3) / 1000 : undefined,
    periodDays: def.kind === 'star' ? null : orbitalPeriodDays(def.id),
    moons: Math.max(modelled, def.physical.knownMoons ?? 0),
  };
}

const RATES: Array<[number, string]> = [
  [1, 'Real time'],
  [60, '1 min / s'],
  [600, '10 min / s'],
  [3600, '1 hour / s'],
  [21600, '6 hours / s'],
  [86400, '1 day / s'],
  [604800, '1 week / s'],
  [2629800, '1 month / s'],
  [31557600, '1 year / s'],
  [315576000, '10 years / s'],
];
export const RATE_STEPS = RATES.map(([r]) => r);

export function rateLabel(rate: number): string {
  const found = RATES.find(([r]) => r === Math.abs(rate));
  const text = found ? found[1] : `${sig(Math.abs(rate), 2)}× `;
  return rate < 0 ? `−${text}` : text;
}

export function utcDate(d: Date) {
  const iso = d.toISOString();
  const y = d.getUTCFullYear();
  const date = y < 0 || y > 9999 ? iso.slice(0, 13) : iso.slice(0, 10);
  return { date, time: iso.slice(11, 19), weekday: d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }) };
}

export const KIND_LABEL: Record<string, string> = {
  star: 'Star',
  planet: 'Planet',
  dwarf: 'Dwarf planet',
  moon: 'Moon',
  asteroid: 'Asteroid',
  comet: 'Comet',
};
