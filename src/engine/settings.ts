export type Quality = 'low' | 'medium' | 'high' | 'ultra';

export interface Settings {
  quality: Quality;
  orbits: boolean;
  labels: boolean;
  belts: boolean;
  tails: boolean;
  milkyWay: number;
  bloom: boolean;
  masterVolume: number;
  musicVolume: number;
  bodyVolume: number;
  ambienceVolume: number;
  uiVolume: number;
  autoPlayBodySounds: boolean;
  muted: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  quality: 'high',
  orbits: true,
  labels: true,
  belts: true,
  tails: true,
  milkyWay: 0.55,
  bloom: true,
  masterVolume: 0.8,
  musicVolume: 0.55,
  bodyVolume: 0.75,
  ambienceVolume: 0.35,
  uiVolume: 0.5,
  autoPlayBodySounds: true,
  muted: false,
};

export const QUALITY: Record<Quality, { pixelRatio: number; belts: number; anisotropy: number; flare: boolean; label: string }> = {
  low: { pixelRatio: 1, belts: 0.25, anisotropy: 2, flare: false, label: 'Low' },
  medium: { pixelRatio: 1.5, belts: 0.5, anisotropy: 4, flare: false, label: 'Medium' },
  high: { pixelRatio: 2, belts: 1, anisotropy: 8, flare: true, label: 'High' },
  ultra: { pixelRatio: 3, belts: 1, anisotropy: 16, flare: true, label: 'Ultra' },
};

const KEY = 'solar-system.settings.v2';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage can be unavailable inside sandboxed iframes; settings then last for the session.
  }
}
