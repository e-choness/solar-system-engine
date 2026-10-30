<script lang="ts">
  import { audio } from './state.svelte.ts';

  let { active, color }: { active: boolean; color: string } = $props();
  let canvas: HTMLCanvasElement;

  $effect(() => {
    const ctx = canvas.getContext('2d')!;
    const wave = new Uint8Array(new ArrayBuffer(1024));
    const spec = new Uint8Array(new ArrayBuffer(512));
    let raf = 0;
    let energy = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth * dpr;
      const h = canvas.clientHeight * dpr;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.clearRect(0, 0, w, h);
      if (active) {
        audio.waveform(wave);
        audio.spectrum(spec);
      } else {
        wave.fill(128);
        spec.fill(0);
      }
      // Spectrum bars.
      const bars = 48;
      let sum = 0;
      for (let i = 0; i < bars; i++) {
        const v = spec[Math.floor((i / bars) ** 1.6 * 200)] / 255;
        sum += v;
        const bh = Math.max(1.5 * dpr, v * h * 0.85);
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.18 + v * 0.45;
        const bw = w / bars;
        ctx.fillRect(i * bw + bw * 0.2, h - bh, bw * 0.6, bh);
      }
      energy += (sum / bars - energy) * 0.1;
      // Waveform line on top.
      ctx.globalAlpha = 0.95;
      ctx.lineWidth = 1.6 * dpr;
      ctx.strokeStyle = 'white';
      ctx.shadowColor = color;
      ctx.shadowBlur = 10 * dpr * (0.4 + energy);
      ctx.beginPath();
      for (let i = 0; i < wave.length; i += 4) {
        const x = (i / (wave.length - 1)) * w;
        const y = h * 0.45 + ((wave[i] - 128) / 128) * h * 0.4;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    };
    draw();
    return () => cancelAnimationFrame(raf);
  });
</script>

<canvas bind:this={canvas} class="viz" aria-hidden="true"></canvas>

<style>
  .viz {
    display: block;
    width: 100%;
    height: 64px;
    border-radius: 12px;
    background: linear-gradient(180deg, rgba(0, 0, 0, 0.25), rgba(0, 0, 0, 0.1));
    border: 1px solid rgba(255, 255, 255, 0.06);
  }
</style>
