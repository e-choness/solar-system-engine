import type { BodyDef } from '../data/types.ts';
import type { Settings } from '../engine/settings.ts';
import { clipGain } from './loudness.ts';
import { sonify, type Voice } from './sonify.ts';

const AUDIO = `${import.meta.env.BASE_URL}audio/`;

export type UiSound = 'hover' | 'click' | 'open' | 'close' | 'warp';

/**
 * Mixer for the whole game:
 *   music ─┐
 *   body ──┼─► master ─► compressor ─► out
 *   amb  ──┤
 *   ui   ──┘           (body + ui also feed a shared reverb)
 */
export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private music!: GainNode;
  private musicDuck!: GainNode;
  private body!: GainNode;
  private bodyProximity!: GainNode;
  private bodyFilter!: BiquadFilterNode;
  private ambience!: GainNode;
  private ui!: GainNode;
  private reverb!: ConvolverNode;
  private analyser!: AnalyserNode;
  private musicEl: HTMLAudioElement | null = null;
  private deepLayer: GainNode | null = null;
  private readonly buffers = new Map<string, Promise<AudioBuffer>>();
  private current: { id: string; voice: Voice } | null = null;
  private settings: Settings;
  private backgrounded = false;
  playingId: string | null = null;

  constructor(settings: Settings) {
    this.settings = settings;
  }

  /** Must be called from a user gesture (browser autoplay policy). */
  async start() {
    if (this.ctx) return;
    const ctx = new AudioContext({ latencyHint: 'playback' });
    this.ctx = ctx;
    // iOS can create the context suspended even inside a gesture.
    void ctx.resume();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 3;
    this.master = ctx.createGain();
    this.master.connect(comp).connect(ctx.destination);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(4.5, 2.6);
    const rvGain = ctx.createGain();
    rvGain.gain.value = 0.55;
    this.reverb.connect(rvGain).connect(this.master);

    this.music = ctx.createGain();
    this.musicDuck = ctx.createGain();
    this.music.connect(this.musicDuck).connect(this.master);

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.82;
    this.body = ctx.createGain();
    this.bodyFilter = ctx.createBiquadFilter();
    this.bodyFilter.type = 'lowpass';
    this.bodyFilter.frequency.value = 18000;
    this.bodyProximity = ctx.createGain();
    this.body.connect(this.bodyFilter).connect(this.bodyProximity).connect(this.analyser).connect(this.master);

    this.ambience = ctx.createGain();
    this.ambience.connect(this.master);
    this.ui = ctx.createGain();
    this.ui.connect(this.master);

    this.applySettings(this.settings);

    // Music streams from an <audio> element so the 4-minute track needn't be decoded up front.
    const el = new Audio(`${AUDIO}original/soundtrack.m4a`);
    el.loop = true;
    el.crossOrigin = 'anonymous';
    ctx.createMediaElementSource(el).connect(this.music);
    this.musicEl = el;
    this.music.gain.setValueAtTime(0, ctx.currentTime);
    this.music.gain.linearRampToValueAtTime(1, ctx.currentTime + 6);
    el.play().catch(() => undefined);

    // Ambient beds from the original game: a soft hum near the Sun, a darker drone in deep space.
    this.loop('original/drone-hum.m4a', this.ambience);
    this.deepLayer = ctx.createGain();
    this.deepLayer.gain.value = 0;
    this.deepLayer.connect(this.ambience);
    this.loop('original/drone-dark.m4a', this.deepLayer);
  }

  /** Mobile: the soundtrack shouldn't carry on from a pocket after the player switches away. */
  setBackgrounded(hidden: boolean) {
    if (!this.ctx) return;
    this.backgrounded = hidden;
    if (hidden) {
      this.musicEl?.pause();
      void this.ctx.suspend();
    } else {
      this.wake();
    }
  }

  /** Restarts audio that the OS stopped (a call, an app switch); iOS only allows this from a gesture. */
  wake() {
    if (!this.ctx || this.backgrounded) return;
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => undefined);
    if (this.musicEl?.paused) this.musicEl.play().catch(() => undefined);
  }

  applySettings(s: Settings) {
    this.settings = s;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const set = (g: GainNode, v: number) => g.gain.setTargetAtTime(v, t, 0.15);
    set(this.master, s.muted ? 0 : s.masterVolume);
    set(this.musicDuck, s.musicVolume * (this.current ? 0.45 : 1));
    set(this.body, s.bodyVolume);
    set(this.ambience, s.ambienceVolume);
    set(this.ui, s.uiVolume * 0.6);
  }

  private impulse(seconds: number, decay: number) {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** decay;
    }
    return buf;
  }

  private buffer(path: string) {
    let p = this.buffers.get(path);
    if (!p) {
      p = fetch(AUDIO + path)
        .then((r) => {
          if (!r.ok) throw new Error(`${r.status} ${path}`);
          return r.arrayBuffer();
        })
        .then((b) => this.ctx!.decodeAudioData(b));
      this.buffers.set(path, p);
    }
    return p;
  }

  /** Loops a clip at the common loudness. */
  private async loop(path: string, out: AudioNode) {
    const buf = await this.buffer(path).catch(() => null);
    if (!buf || !this.ctx) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const g = this.ctx.createGain();
    g.gain.value = clipGain(path);
    src.connect(g).connect(out);
    src.start();
  }

  /** Plays the body's own sound: a recording if one exists, otherwise its sonification. */
  async playBody(def: BodyDef) {
    if (!this.ctx) return;
    if (this.current?.id === def.id) return;
    this.stopBody();
    const ctx = this.ctx;
    const id = def.id;
    this.playingId = id;
    let voice: Voice;
    if (def.audio.src) {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(this.body);
      const send = ctx.createGain();
      send.gain.value = 0.25;
      g.connect(send).connect(this.reverb);
      let src: AudioBufferSourceNode | null = null;
      let stopped = false;
      voice = {
        stop: (fade = 1.2) => {
          stopped = true;
          const t = ctx.currentTime;
          g.gain.cancelScheduledValues(t);
          g.gain.setValueAtTime(g.gain.value, t);
          g.gain.linearRampToValueAtTime(0, t + fade);
          src?.stop(t + fade + 0.05);
          window.setTimeout(() => g.disconnect(), (fade + 0.3) * 1000);
        },
      };
      this.current = { id, voice };
      const buf = await this.buffer(def.audio.src).catch(() => null);
      if (!buf || stopped) return;
      src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(g);
      src.start();
      // The original clips were mastered anywhere from −29 to −15 LUFS: play them all at one loudness.
      g.gain.linearRampToValueAtTime(clipGain(def.audio.src), ctx.currentTime + 1.5);
    } else {
      voice = sonify(ctx, def, this.body, this.reverb);
      this.current = { id, voice };
    }
    this.applySettings(this.settings);
  }

  stopBody() {
    this.current?.voice.stop();
    this.current = null;
    this.playingId = null;
    this.applySettings(this.settings);
  }

  /**
   * 0 = far away (quiet, muffled), 1 = right next to the body.
   * Called every frame with the camera distance in body radii.
   */
  setProximity(radii: number) {
    if (!this.ctx) return;
    const near = Math.min(1, Math.max(0, (Math.log10(3000) - Math.log10(Math.max(radii, 1))) / (Math.log10(3000) - Math.log10(4))));
    const t = this.ctx.currentTime;
    this.bodyProximity.gain.setTargetAtTime(0.3 + 0.7 * near, t, 0.3);
    this.bodyFilter.frequency.setTargetAtTime(700 * 2 ** (near * 4.7), t, 0.3);
  }

  /** 0 inside the planets' region, 1 beyond the Kuiper belt. */
  setDeepSpace(amount: number) {
    if (!this.ctx || !this.deepLayer) return;
    this.deepLayer.gain.setTargetAtTime(amount, this.ctx.currentTime, 1.5);
  }

  waveform(out: Uint8Array<ArrayBuffer>) {
    if (this.analyser) this.analyser.getByteTimeDomainData(out);
  }

  spectrum(out: Uint8Array<ArrayBuffer>) {
    if (this.analyser) this.analyser.getByteFrequencyData(out);
  }

  /** Filtered-noise swoosh for camera flights. */
  whoosh(duration: number) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const len = Math.max(0.6, duration);
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * (len + 0.5)), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.9;
    bp.frequency.setValueAtTime(180, t);
    bp.frequency.exponentialRampToValueAtTime(1400, t + len * 0.5);
    bp.frequency.exponentialRampToValueAtTime(220, t + len);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.22, t + len * 0.45);
    g.gain.linearRampToValueAtTime(0, t + len);
    src.connect(bp).connect(g).connect(this.ui);
    g.connect(this.reverb);
    src.start(t);
    src.stop(t + len + 0.1);
  }

  sfx(kind: UiSound) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const blip = (freq: number, at: number, dur: number, gain: number, type: OscillatorType = 'sine') => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t + at);
      g.gain.setValueAtTime(0, t + at);
      g.gain.linearRampToValueAtTime(gain, t + at + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
      o.connect(g).connect(this.ui);
      o.start(t + at);
      o.stop(t + at + dur + 0.02);
    };
    switch (kind) {
      case 'hover':
        blip(2400, 0, 0.05, 0.04);
        break;
      case 'click':
        blip(1320, 0, 0.09, 0.08);
        blip(1980, 0.045, 0.12, 0.06);
        break;
      case 'open':
        blip(660, 0, 0.18, 0.06, 'triangle');
        blip(990, 0.06, 0.22, 0.05, 'triangle');
        break;
      case 'close':
        blip(990, 0, 0.14, 0.05, 'triangle');
        blip(660, 0.05, 0.18, 0.04, 'triangle');
        break;
      case 'warp':
        blip(440, 0, 0.25, 0.05, 'sawtooth');
        blip(880, 0.03, 0.25, 0.03, 'sine');
        break;
    }
  }

  get musicPlaying() {
    return Boolean(this.musicEl && !this.musicEl.paused);
  }
}
