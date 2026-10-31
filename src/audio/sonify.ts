import type { BodyDef } from '../data/types.ts';
import { dbToGain, TARGET_LUFS } from './loudness.ts';

/**
 * Generative "voice" for bodies that have never been recorded: the physical
 * parameters drive the synthesis so every world sounds distinct and the sound
 * says something about it.
 *  - size        → fundamental pitch (big worlds rumble, small ones ring)
 *  - spin rate   → modulation speed
 *  - temperature → brightness of the filter
 *  - surface     → timbre (ice = glassy partials, rock = filtered noise, comet = hiss)
 */
export interface Voice {
  stop(fade?: number): void;
}

export interface SonificationParams {
  f0: number;
  lfoHz: number;
  cutoff: number;
  timbre: 'ice' | 'rock' | 'gas' | 'comet' | 'metal' | 'earth' | 'moon';
}

/**
 * Loudness each timbre renders at with the gains below and a voice gain of 1
 * (K-weighted LUFS, rendered offline by scripts/measure-voices.mjs). Voices are
 * trimmed from these to the mixer's target so they sit level with the recordings.
 */
export const RENDERED_LUFS: Record<SonificationParams['timbre'], number> = {
  ice: -13.3,
  moon: -12.3,
  gas: -13.3,
  rock: -6.5,
  comet: -13.3,
  metal: -22.9,
  earth: -12.5,
};

const hash = (s: string) => [...s].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);

export function sonificationParams(def: BodyDef): SonificationParams {
  const r = def.physical.radius;
  const f0 = Math.min(420, Math.max(38, 440 / (1 + Math.log2(1 + r / 50))));
  const rot = Math.abs(def.physical.rotationH ?? 24);
  const lfoHz = Math.min(1.6, Math.max(0.03, 24 / rot / 4));
  const cutoff = Math.min(6000, Math.max(450, 300 + (def.physical.tempK ?? 90) * 7));
  const p = def.visual.procedural;
  let timbre: SonificationParams['timbre'] = 'ice';
  if (def.id === 'earth') timbre = 'earth';
  else if (def.id === 'moon') timbre = 'moon';
  else if (def.kind === 'comet' || p === 'comet') timbre = 'comet';
  else if (p === 'metal') timbre = 'metal';
  else if (def.class.includes('giant')) timbre = 'gas';
  else if (p === 'rocky' || p === 'cratered' || p === 'dusty' || def.kind === 'asteroid' || (def.physical.albedo ?? 0.5) < 0.2)
    timbre = 'rock';
  return { f0, lfoHz, cutoff, timbre };
}

let noiseBuffer: AudioBuffer | null = null;
function noise(ctx: AudioContext) {
  if (!noiseBuffer) {
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate);
    const d = noiseBuffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      // Brown-ish noise: integrated white noise, gentle on the ears.
      last = (last + (Math.random() * 2 - 1) * 0.06) * 0.996;
      d[i] = last * 3.2;
    }
  }
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = true;
  return src;
}

export function sonify(ctx: AudioContext, def: BodyDef, out: AudioNode, send: AudioNode): Voice {
  const { f0, lfoHz, cutoff, timbre } = sonificationParams(def);
  const seed = hash(def.id);
  const rand = (k: number) => ((seed >>> (k % 24)) & 0xff) / 255;
  const now = ctx.currentTime;
  const voice = ctx.createGain();
  voice.gain.setValueAtTime(0, now);
  voice.gain.linearRampToValueAtTime(dbToGain(TARGET_LUFS - RENDERED_LUFS[timbre]), now + 2.5);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = cutoff;
  filter.Q.value = 0.7;
  filter.connect(voice);
  voice.connect(out);
  const wet = ctx.createGain();
  wet.gain.value = timbre === 'ice' || timbre === 'moon' ? 0.75 : 0.45;
  voice.connect(wet).connect(send);

  const sources: AudioScheduledSourceNode[] = [];
  const timers: number[] = [];
  const lfo = ctx.createOscillator();
  lfo.frequency.value = lfoHz;
  sources.push(lfo);

  const tone = (freq: number, gain: number, type: OscillatorType = 'sine', detune = 0) => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    o.detune.value = detune;
    const g = ctx.createGain();
    g.gain.value = gain;
    o.connect(g).connect(filter);
    sources.push(o);
    return { o, g };
  };
  const tremolo = (g: GainNode, depth: number) => {
    const d = ctx.createGain();
    d.gain.value = depth;
    lfo.connect(d).connect(g.gain);
  };

  switch (timbre) {
    case 'ice':
    case 'moon': {
      const partials = timbre === 'moon' ? [1, 2, 3.01] : [1, 1.5, 2.01, 3.02];
      partials.forEach((m, k) => {
        tremolo(tone(f0 * m, 0.16 / (k + 1), 'sine', (rand(k) - 0.5) * 12).g, 0.05);
      });
      const shimmer = tone(f0 * 8 * (1 + rand(3) * 0.1), 0.025);
      tremolo(shimmer.g, 0.025);
      break;
    }
    case 'gas': {
      [1, 1.5, 2, 3].forEach((m, k) => {
        tremolo(tone(f0 * m, 0.14 / (k + 1), k ? 'sine' : 'triangle', (rand(k) - 0.5) * 8).g, 0.06);
      });
      break;
    }
    case 'rock': {
      const n = noise(ctx);
      const bp = ctx.createBiquadFilter();
      bp.type = 'lowpass';
      bp.frequency.value = f0 * 3;
      bp.Q.value = 4;
      const ng = ctx.createGain();
      ng.gain.value = 0.35;
      n.connect(bp).connect(ng).connect(filter);
      const sweep = ctx.createGain();
      sweep.gain.value = f0 * 1.5;
      lfo.connect(sweep).connect(bp.frequency);
      sources.push(n);
      tone(f0, 0.12);
      tone(f0 / 2, 0.1, 'triangle');
      break;
    }
    case 'comet': {
      const n = noise(ctx);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 900;
      bp.Q.value = 1.4;
      const ng = ctx.createGain();
      ng.gain.value = 0.7;
      n.connect(bp).connect(ng).connect(filter);
      const sweep = ctx.createGain();
      sweep.gain.value = 600;
      lfo.connect(sweep).connect(bp.frequency);
      sources.push(n);
      const whistle = tone(f0 * 4, 0.03);
      const vib = ctx.createGain();
      vib.gain.value = 6;
      lfo.connect(vib).connect(whistle.o.frequency);
      filter.frequency.value = Math.max(cutoff, 3500);
      break;
    }
    case 'metal': {
      // Bell-like FM pings, slowly repeating.
      const ping = () => {
        const t = ctx.currentTime;
        const car = ctx.createOscillator();
        const mod = ctx.createOscillator();
        const mg = ctx.createGain();
        const g = ctx.createGain();
        car.frequency.value = f0 * 2 * (1 + Math.floor(Math.random() * 3) * 0.5);
        mod.frequency.value = car.frequency.value * Math.SQRT2;
        mg.gain.setValueAtTime(car.frequency.value * 2, t);
        mg.gain.exponentialRampToValueAtTime(1, t + 3);
        g.gain.setValueAtTime(0.16, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 3.5);
        mod.connect(mg).connect(car.frequency);
        car.connect(g).connect(filter);
        car.start(t);
        mod.start(t);
        car.stop(t + 3.6);
        mod.stop(t + 3.6);
      };
      ping();
      timers.push(window.setInterval(ping, 2600 + rand(5) * 1600));
      tone(f0, 0.06, 'sine');
      break;
    }
    case 'earth': {
      // Warm major triad + ocean-like swells + occasional rising "chorus" chirps,
      // a nod to the whistler-mode chorus waves recorded in Earth's magnetosphere.
      [1, 1.25, 1.5, 2].forEach((m, k) => {
        tremolo(tone(f0 * m, 0.12 / (k + 1), 'sine', (rand(k) - 0.5) * 6).g, 0.04);
      });
      const n = noise(ctx);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 500;
      const ng = ctx.createGain();
      ng.gain.value = 0.12;
      const swell = ctx.createGain();
      swell.gain.value = 0.1;
      lfo.connect(swell).connect(ng.gain);
      n.connect(lp).connect(ng).connect(voice);
      sources.push(n);
      const chirp = () => {
        const t = ctx.currentTime;
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        const base = 1200 + Math.random() * 900;
        o.frequency.setValueAtTime(base, t);
        o.frequency.exponentialRampToValueAtTime(base * 2.2, t + 0.35);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.02, t + 0.05);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
        o.connect(g).connect(voice);
        g.connect(send);
        o.start(t);
        o.stop(t + 0.45);
      };
      timers.push(window.setInterval(() => Math.random() < 0.7 && chirp(), 900));
      break;
    }
  }

  for (const s of sources) s.start(now);

  return {
    stop(fade = 1.2) {
      const t = ctx.currentTime;
      voice.gain.cancelScheduledValues(t);
      voice.gain.setValueAtTime(voice.gain.value, t);
      voice.gain.linearRampToValueAtTime(0, t + fade);
      for (const s of sources) s.stop(t + fade + 0.05);
      for (const id of timers) clearInterval(id);
      window.setTimeout(
        () => {
          voice.disconnect();
          wet.disconnect();
        },
        (fade + 0.2) * 1000,
      );
    },
  };
}
