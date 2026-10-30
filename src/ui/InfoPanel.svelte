<script lang="ts">
  import { AudioLines, Crosshair, ExternalLink, Pause, Play, Sparkles, X } from '@lucide/svelte';
  import { BODY_BY_ID } from '../data/catalog.ts';
  import credits from '../data/generated/credits.json' with { type: 'json' };
  import { bodyStats, distance, duration, KIND_LABEL, mass, sig, temperature } from './format.ts';
  import { app, audio, engine } from './state.svelte.ts';
  import Visualizer from './Visualizer.svelte';

  let { id }: { id: string } = $props();

  const def = $derived(BODY_BY_ID.get(id)!);
  const parent = $derived(def.parent ? BODY_BY_ID.get(def.parent) : undefined);
  const d = $derived(bodyStats(def));
  const live = $derived(app.telemetry ? engine.live(id) : null);
  const focused = $derived(app.telemetry?.focusId === id);
  const texCredit = $derived(def.visual.map ? (credits.textures as Record<string, { author: string; license: string; url: string }>)[def.visual.map] : null);
  let playing = $state(false);

  $effect(() => {
    // Track the shared audio engine (it can switch voices when selection changes).
    const t = setInterval(() => (playing = audio.playingId === id), 200);
    return () => clearInterval(t);
  });

  function toggleSound() {
    if (audio.playingId === id) audio.stopBody();
    else audio.playBody(def);
    playing = audio.playingId === id;
  }

  const stats = $derived.by(() => {
    const p = def.physical;
    const rows: Array<[string, string, string?]> = [];
    rows.push(['Radius', `${sig(p.radius, 4)} km`, p.radius > 1000 && def.id !== 'earth' ? `${sig(p.radius / 6371, 3)} × Earth` : undefined]);
    if (p.mass) rows.push(['Mass', mass(p.mass)]);
    if (d.gravity) rows.push(['Surface gravity', `${sig(d.gravity, 3)} m/s²`, `${sig(d.gravity / 9.80665, 3)} g`]);
    if (d.escape) rows.push(['Escape velocity', `${sig(d.escape, 3)} km/s`]);
    if (d.density) rows.push(['Density', `${sig(d.density, 3)} g/cm³`]);
    if (p.rotationH) rows.push([def.tidallyLocked ? 'Day (synchronous)' : 'Day length', duration(p.rotationH)]);
    if (d.periodDays) rows.push([def.kind === 'moon' ? 'Orbit' : 'Year', duration(d.periodDays * 24)]);
    if (p.obliquity !== undefined) rows.push(['Axial tilt', `${sig(p.obliquity, 3)}°`]);
    if (p.tempK || p.tempRange) rows.push(['Temperature', temperature(p.tempK, p.tempRange), p.tempK && !p.tempRange ? `${Math.round(p.tempK)} K` : undefined]);
    if (p.albedo) rows.push(['Albedo', sig(p.albedo, 2)]);
    if (d.moons) rows.push(['Moons', String(d.moons)]);
    return rows;
  });

  const sunDist = $derived(live ? distance(live.sunDistanceKm) : null);
  const camDist = $derived(live ? distance(Math.max(0, live.cameraDistanceKm - def.physical.radius)) : null);
  const lightMin = $derived(live ? live.sunDistanceKm / 299792.458 / 60 : 0);
</script>

<aside class="info glass" aria-label="{def.name} details">
  <div class="hero" style:--c={def.visual.color}>
    <div class="orb"></div>
    <button class="icon-btn close" aria-label="Close" onclick={() => engine.select(null)}><X size={16} /></button>
    <div class="chips">
      <span class="chip kind-{def.kind}">{KIND_LABEL[def.kind]}</span>
      {#if parent && def.kind === 'moon'}<span class="chip">of {parent.name}</span>{/if}
    </div>
    <h2>{def.name}</h2>
    <div class="class">{def.class}</div>
    <div class="actions">
      {#if !focused}
        <button class="pill-btn primary" onclick={() => engine.focus(id)}><Crosshair size={15} /> Fly here</button>
      {:else}
        <span class="here"><Sparkles size={14} /> You are here</span>
      {/if}
      <button class="pill-btn" onclick={toggleSound} aria-pressed={playing}>
        {#if playing}<Pause size={15} /> Pause sound{:else}<Play size={15} /> Listen{/if}
      </button>
      <a class="icon-btn" href={def.wiki} target="_blank" rel="noopener" title="Read more on Wikipedia" aria-label="Wikipedia"><ExternalLink size={16} /></a>
    </div>
  </div>

  <div class="body scroll">
    {#if live}
      <div class="live">
        <div>
          <span class="k">From Sun</span>
          <span class="v mono">{sunDist?.value}<small>{sunDist?.unit}</small></span>
          <span class="s">{def.kind === 'star' ? 'centre of it all' : `light takes ${lightMin < 120 ? `${sig(lightMin, 3)} min` : `${sig(lightMin / 60, 3)} h`}`}</span>
        </div>
        <div>
          <span class="k">From you</span>
          <span class="v mono">{camDist?.value}<small>{camDist?.unit}</small></span>
          <span class="s">to the surface</span>
        </div>
        <div>
          <span class="k">{parent && def.kind === 'moon' ? `Around ${parent.name}` : 'Speed'}</span>
          <span class="v mono">{def.kind === 'star' ? '—' : sig(live.speedKms, 3)}<small>{def.kind === 'star' ? '' : 'km/s'}</small></span>
          {#if live.parentDistanceKm}<span class="s">{distance(live.parentDistanceKm).value} {distance(live.parentDistanceKm).unit} away</span>{/if}
        </div>
      </div>
    {/if}

    <p class="desc">{def.description}</p>

    <dl class="stats">
      {#each stats as [k, v, sub] (k)}
        <div>
          <dt>{k}</dt>
          <dd><span class="mono">{v}</span>{#if sub}<small>{sub}</small>{/if}</dd>
        </div>
      {/each}
    </dl>

    {#if def.physical.atmosphere}
      <div class="block">
        <h3>Atmosphere</h3>
        <p>{def.physical.atmosphere}</p>
      </div>
    {/if}

    {#if def.facts?.length}
      <div class="block">
        <h3>Did you know</h3>
        <ul class="facts">
          {#each def.facts as f}<li>{f}</li>{/each}
        </ul>
      </div>
    {/if}

    <div class="block">
      <h3>Discovery & exploration</h3>
      {#if def.discovered}<p class="disc">{def.discovered}</p>{/if}
      {#if def.missions?.length}
        <div class="missions">
          {#each def.missions as m}<span class="chip">{m}</span>{/each}
        </div>
      {:else}
        <p class="dim">No spacecraft has visited yet.</p>
      {/if}
    </div>

    <div class="block sound">
      <h3><AudioLines size={14} /> Sound of {def.name}</h3>
      <Visualizer active={playing} color={def.visual.color} />
      {#if def.audio.kind === 'sonification'}
        <p class="dim">
          Sonification generated live from {def.name}’s physical data: size sets the pitch, spin sets the pulse, temperature sets the brightness and the
          surface sets the timbre.
        </p>
      {:else}
        <p class="dim">{def.audio.caption}</p>
        <p class="credit">{def.audio.kind === 'original' ? 'Recording' : 'Recording'}: {def.audio.credit}</p>
      {/if}
    </div>

    {#if texCredit}
      <p class="credit tex">
        {#if def.visual.impression}Artist’s impression — no detailed spacecraft map exists. {/if}Surface map: {texCredit.author.replace(/\s+/g, ' ').slice(0, 80)}
        · {texCredit.license}
      </p>
    {/if}
  </div>
</aside>

<style>
  .info {
    position: fixed;
    top: 72px;
    right: 14px;
    bottom: 104px;
    width: 360px;
    display: flex;
    flex-direction: column;
    z-index: 15;
    overflow: hidden;
    animation: panel-in 0.45s var(--ease) both;
  }
  @keyframes panel-in {
    from {
      opacity: 0;
      transform: translateX(18px);
    }
  }
  .hero {
    position: relative;
    padding: 20px 20px 16px;
    overflow: hidden;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }
  .orb {
    position: absolute;
    right: -60px;
    top: -70px;
    width: 220px;
    height: 220px;
    border-radius: 50%;
    background: radial-gradient(circle at 35% 35%, color-mix(in srgb, var(--c) 85%, white), var(--c) 40%, transparent 72%);
    opacity: 0.32;
    filter: blur(6px);
    pointer-events: none;
  }
  .close {
    position: absolute;
    top: 10px;
    right: 10px;
    width: 32px;
    height: 32px;
  }
  .chips {
    display: flex;
    gap: 6px;
  }
  .chip.kind-planet {
    color: var(--kind-planet);
  }
  .chip.kind-moon {
    color: var(--kind-moon);
  }
  .chip.kind-dwarf {
    color: var(--kind-dwarf);
  }
  .chip.kind-star {
    color: var(--kind-star);
  }
  .chip.kind-asteroid {
    color: var(--kind-asteroid);
  }
  .chip.kind-comet {
    color: var(--kind-comet);
  }
  h2 {
    position: relative;
    margin: 10px 0 2px;
    font-family: var(--font-display);
    font-size: 30px;
    font-weight: 600;
    letter-spacing: 0.01em;
    line-height: 1.1;
  }
  .class {
    position: relative;
    color: var(--text-dim);
    font-size: 13px;
  }
  .actions {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 14px;
  }
  .actions .pill-btn {
    padding: 8px 14px;
    font-size: 13px;
  }
  .here {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    color: var(--warm);
    padding: 0 6px;
  }
  .body {
    flex: 1;
    padding: 14px 20px 20px;
  }
  .live {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    margin-bottom: 14px;
  }
  .live > div {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 10px;
    border-radius: 12px;
    background: rgba(0, 0, 0, 0.2);
    border: 1px solid rgba(255, 255, 255, 0.06);
    min-width: 0;
  }
  .k {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .v {
    font-size: 15px;
    font-weight: 600;
    white-space: nowrap;
  }
  .v small {
    margin-left: 3px;
    font-size: 10.5px;
    color: var(--text-dim);
    font-weight: 500;
  }
  .s {
    font-size: 10.5px;
    color: var(--text-faint);
  }
  .desc {
    margin: 0 0 14px;
    line-height: 1.62;
    color: rgba(230, 236, 255, 0.86);
    font-size: 13.5px;
  }
  .stats {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1px;
    margin: 0 0 16px;
    border-radius: 12px;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.06);
  }
  .stats > div {
    padding: 9px 11px;
    background: rgba(10, 14, 30, 0.35);
  }
  dt {
    font-size: 10.5px;
    color: var(--text-faint);
    letter-spacing: 0.04em;
  }
  dd {
    margin: 3px 0 0;
    font-size: 13px;
    display: flex;
    flex-direction: column;
  }
  dd small {
    font-size: 11px;
    color: var(--text-dim);
  }
  .block {
    margin-bottom: 16px;
  }
  h3 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 0 8px;
    font-size: 11px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-faint);
    font-weight: 700;
  }
  .block p {
    margin: 0;
    font-size: 13px;
    line-height: 1.55;
    color: var(--text-dim);
  }
  .facts {
    margin: 0;
    padding-left: 18px;
    color: var(--text-dim);
    font-size: 13px;
    line-height: 1.55;
  }
  .facts li::marker {
    color: var(--accent);
  }
  .disc {
    margin-bottom: 8px !important;
  }
  .missions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .dim {
    color: var(--text-faint) !important;
    font-size: 12px !important;
  }
  .sound p {
    margin-top: 8px;
  }
  .credit {
    font-size: 11px !important;
    color: var(--text-faint) !important;
    margin-top: 4px !important;
  }
  .credit.tex {
    margin: 0;
    line-height: 1.5;
  }
  @media (max-width: 760px) {
    .info {
      top: auto;
      left: 10px;
      right: 10px;
      width: auto;
      height: 52vh;
      bottom: 120px;
    }
  }
</style>
