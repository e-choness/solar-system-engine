<script lang="ts">
  import { Headphones, Rocket } from '@lucide/svelte';
  import { app } from './state.svelte.ts';

  let { onbegin }: { onbegin: () => void } = $props();
  let leaving = $state(false);

  function go() {
    leaving = true;
    onbegin();
  }
</script>

<div class="title" class:leaving class:ready={app.stage === 'title'}>
  <div class="vignette"></div>
  <div class="hero">
    <div class="eyebrow">A true-scale journey</div>
    <h1><span class="a">SOLAR</span><span class="b">SYSTEM</span></h1>
    <p class="tag">Fly from the Sun’s fire to the frozen edge of the Oort cloud — every world where it really is, right now.</p>

    {#if app.stage === 'loading'}
      <div class="progress" role="progressbar" aria-valuenow={Math.round(app.progress * 100)} aria-valuemin="0" aria-valuemax="100">
        <div class="bar" style:width="{Math.round(app.progress * 100)}%"></div>
      </div>
      <div class="status">{app.progressLabel}…</div>
    {:else if app.stage === 'title'}
      <button class="pill-btn primary begin" onclick={go} disabled={leaving}>
        <Rocket size={18} /> Begin the journey
      </button>
      <div class="hint"><Headphones size={14} /> Best with headphones · sounds of every world</div>
    {:else if app.stage === 'error'}
      <div class="error glass">
        <strong>The engine could not start.</strong>
        <p>{app.error}</p>
        <p class="dim">This experience needs a browser with WebGPU or WebGL 2 (recent Chrome, Edge, Firefox or Safari).</p>
      </div>
    {/if}
  </div>
  <footer>
    <span>v{__APP_VERSION__}</span>
    {#if app.backend}<span>· {app.backend}</span>{/if}
    <span>· by Echo Yin</span>
  </footer>
</div>

<style>
  .title {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    z-index: 50;
    transition: opacity 1.2s var(--ease);
  }
  .title.leaving {
    opacity: 0;
    pointer-events: none;
  }
  .vignette {
    position: absolute;
    inset: 0;
    background:
      radial-gradient(70% 60% at 50% 50%, rgba(0, 0, 0, 0.15), rgba(0, 0, 0, 0.75) 100%),
      linear-gradient(180deg, rgba(4, 8, 20, 0.35), rgba(0, 0, 0, 0.55));
    backdrop-filter: blur(2px);
  }
  .hero {
    position: relative;
    text-align: center;
    padding: 24px;
    max-width: 720px;
    animation: rise 1.6s var(--ease) both;
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(18px);
    }
  }
  .eyebrow {
    font-family: var(--font-display);
    text-transform: uppercase;
    letter-spacing: 0.42em;
    font-size: 12px;
    color: var(--warm);
    opacity: 0.85;
  }
  h1 {
    margin: 14px 0 10px;
    font-family: var(--font-display);
    font-weight: 300;
    font-size: clamp(48px, 10vw, 112px);
    letter-spacing: 0.16em;
    line-height: 0.95;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  h1 .a {
    font-weight: 700;
    background: linear-gradient(180deg, #fff, #ffe2b0 60%, #ffb35c);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    text-shadow: 0 0 60px rgba(255, 190, 110, 0.25);
  }
  h1 .b {
    font-size: 0.42em;
    letter-spacing: 0.9em;
    margin-right: -0.9em;
    color: rgba(220, 230, 255, 0.85);
  }
  .tag {
    margin: 0 auto 34px;
    max-width: 520px;
    color: var(--text-dim);
    line-height: 1.6;
    font-size: 15px;
  }
  .progress {
    width: min(360px, 80vw);
    height: 4px;
    margin: 0 auto;
    border-radius: 99px;
    background: rgba(255, 255, 255, 0.1);
    overflow: hidden;
  }
  .bar {
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, var(--accent), var(--accent-2), var(--warm));
    box-shadow: 0 0 18px rgba(142, 197, 255, 0.6);
    transition: width 0.4s var(--ease);
  }
  .status {
    margin-top: 12px;
    font-size: 12px;
    color: var(--text-faint);
    letter-spacing: 0.06em;
  }
  .begin {
    font-size: 16px;
    padding: 14px 28px;
    animation: pulse 3s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      box-shadow: 0 0 40px rgba(160, 190, 255, 0.35);
    }
  }
  .hint {
    margin-top: 16px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text-faint);
  }
  .error {
    padding: 18px 22px;
    text-align: left;
  }
  .error p {
    margin: 8px 0 0;
    color: var(--danger);
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .error p.dim {
    color: var(--text-dim);
    font-family: var(--font-ui);
  }
  footer {
    position: absolute;
    bottom: 18px;
    display: flex;
    gap: 6px;
    font-size: 11.5px;
    color: var(--text-faint);
    letter-spacing: 0.04em;
  }
</style>
