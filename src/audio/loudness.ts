import data from '../data/generated/loudness.json' with { type: 'json' };

/** Integrated loudness (LUFS) every body sound and ambient bed is matched to, before the volume sliders. */
export const TARGET_LUFS = -21;
/** Highest true peak (dBTP) a clip may be raised to. */
const PEAK_CEILING = -1;

interface ClipLoudness {
  lufs: number;
  peak: number;
  channels: number;
}
const CLIPS: Record<string, ClipLoudness> = data.clips;

export const dbToGain = (db: number) => 10 ** (db / 20);

/**
 * Gain that plays a clip from public/audio at `target` loudness, using the
 * levels measured by scripts/measure-loudness.mjs. Quiet clips are raised only
 * as far as their peaks allow.
 */
export function clipGain(path: string, target = TARGET_LUFS): number {
  const m = CLIPS[path];
  if (!m) return 1;
  // A mono clip plays on both speakers, which sums to 3 dB louder than measured.
  const heard = m.lufs + (m.channels === 1 ? 3 : 0);
  return dbToGain(Math.min(target - heard, PEAK_CEILING - m.peak));
}
