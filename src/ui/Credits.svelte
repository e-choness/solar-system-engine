<script lang="ts">
  import { ExternalLink, X } from '@lucide/svelte';
  import { BODY_BY_ID } from '../data/catalog.ts';
  import credits from '../data/generated/credits.json' with { type: 'json' };
  import { app } from './state.svelte.ts';

  interface Credit {
    title?: string;
    author: string;
    license: string;
    url: string;
    impression?: boolean;
  }

  const TEXTURE_NAMES: Record<string, string> = {
    'venus-atmosphere': 'Venus clouds',
    'earth-night': 'Earth at night',
    'earth-clouds': 'Earth clouds',
    'earth-normal': 'Earth relief',
    'earth-specular': 'Earth oceans',
    'saturn-ring': 'Saturn’s rings',
    stars: 'Milky Way',
  };

  const textures = Object.entries(credits.textures as Record<string, Credit>).map(([id, c]) => ({
    id,
    name: TEXTURE_NAMES[id] ?? BODY_BY_ID.get(id)?.name ?? id,
    ...c,
    author: c.author.replace(/\s+/g, ' ').replace(/&amp;/g, '&').trim(),
  }));
  const recordings = Object.entries(credits.audio as Record<string, Credit>).map(([file, c]) => ({
    name: [...BODY_BY_ID.values()].find((b) => b.audio.src?.endsWith(file))?.name ?? file,
    ...c,
  }));
  const data = Object.values(credits.data as Record<string, Credit>);
</script>

<div class="backdrop" role="presentation" onclick={() => (app.creditsOpen = false)}></div>
<div class="modal glass" role="dialog" aria-modal="true" aria-label="About and credits">
  <header>
    <div>
      <div class="eyebrow">About</div>
      <h2>Solar System <span class="v mono">v{__APP_VERSION__}</span></h2>
    </div>
    <button class="icon-btn" aria-label="Close" onclick={() => (app.creditsOpen = false)}><X size={16} /></button>
  </header>

  <div class="scroll content">
    <p class="lead">
      A true-scale, real-time model of our Solar System in the browser: {BODY_BY_ID.size} worlds at their real positions for any date between 1800 and 2200,
      with real surface maps, spacecraft recordings and sonifications. A ground-up remake of Echo Yin’s 2021 Unity game.
    </p>
    <div class="links">
      <a class="pill-btn" href="https://echoness.itch.io/solar-system" target="_blank" rel="noopener">itch.io <ExternalLink size={13} /></a>
      <a class="pill-btn" href="https://github.com/e-choness/solar-system-engine" target="_blank" rel="noopener">Source <ExternalLink size={13} /></a>
    </div>

    <div class="license">
      <strong>Non-commercial.</strong> Code is licensed under PolyForm Noncommercial 1.0.0. Music and sounds from the original game are reused by its author for
      non-commercial use only. Third-party maps, recordings and data keep the licenses listed below.
    </div>

    <h3>Music & sound</h3>
    <ul>
      <li>
        <span class="what">Soundtrack, Sun and planet sounds</span>
        <span class="who">Carried over from Solar System (2021) by Echo Yin</span>
        <span class="lic">Non-commercial</span>
      </li>
      {#each recordings as r (r.url)}
        <li>
          <a class="what" href={r.url} target="_blank" rel="noopener">{r.name} — Juno Waves recording</a>
          <span class="who">{r.author}</span>
          <span class="lic">{r.license}</span>
        </li>
      {/each}
      <li>
        <span class="what">Sonifications of every other world</span>
        <span class="who">Synthesised live in your browser from each body’s physical data</span>
        <span class="lic">—</span>
      </li>
    </ul>

    <h3>Surface maps</h3>
    <ul>
      {#each textures as t (t.id)}
        <li>
          <a class="what" href={t.url} target="_blank" rel="noopener">{t.name}{#if t.impression}<em> · artist’s impression</em>{/if}</a>
          <span class="who" title={t.author}>{t.author}</span>
          <span class="lic">{t.license}</span>
        </li>
      {/each}
      <li>
        <span class="what">Every other world</span>
        <span class="who">Procedural surfaces generated on the GPU from each body’s colour and type</span>
        <span class="lic">—</span>
      </li>
    </ul>

    <h3>Science data</h3>
    <ul>
      <li>
        <a class="what" href="https://ssd.jpl.nasa.gov/horizons/" target="_blank" rel="noopener">Orbits of moons and small bodies</a>
        <span class="who">JPL Horizons, NASA/JPL-Caltech Solar System Dynamics</span>
        <span class="lic">Public domain</span>
      </li>
      <li>
        <a class="what" href="https://ssd.jpl.nasa.gov/planets/approx_pos.html" target="_blank" rel="noopener">Planet orbits</a>
        <span class="who">E. M. Standish, Keplerian elements for approximate positions of the major planets</span>
        <span class="lic">Public domain</span>
      </li>
      <li>
        <a class="what" href="https://astrogeology.usgs.gov/groups/iau-wgccre" target="_blank" rel="noopener">Rotation and pole directions</a>
        <span class="who">IAU Working Group on Cartographic Coordinates and Rotational Elements</span>
        <span class="lic">Published data</span>
      </li>
      {#each data as d (d.url)}
        <li>
          <a class="what" href={d.url} target="_blank" rel="noopener">{d.title}</a>
          <span class="who">{d.author}</span>
          <span class="lic">{d.license}</span>
        </li>
      {/each}
      <li>
        <a class="what" href="https://nssdc.gsfc.nasa.gov/planetary/factsheet/" target="_blank" rel="noopener">Physical facts</a>
        <span class="who">NASA Planetary Fact Sheets, JPL SSD and Wikipedia</span>
        <span class="lic">Public domain / CC BY-SA</span>
      </li>
    </ul>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 39;
    background: rgba(0, 0, 0, 0.35);
    animation: fade 0.25s both;
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  .modal {
    position: fixed;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    width: min(820px, calc(100vw - 28px - var(--safe-l) - var(--safe-r)));
    height: min(760px, calc(100vh - 40px));
    height: min(760px, calc(100dvh - 40px - var(--safe-t) - var(--safe-b)));
    display: flex;
    flex-direction: column;
    z-index: 40;
    animation: pop 0.3s var(--ease) both;
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: translate(-50%, -48%) scale(0.98);
    }
  }
  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding: 18px 14px 6px 24px;
  }
  .eyebrow {
    font-size: 10.5px;
    letter-spacing: 0.3em;
    text-transform: uppercase;
    color: var(--warm);
  }
  h2 {
    margin: 4px 0 0;
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 24px;
  }
  .v {
    font-size: 12px;
    color: var(--text-faint);
    font-weight: 400;
  }
  .content {
    flex: 1;
    padding: 6px 24px 24px;
  }
  .lead {
    margin: 6px 0 14px;
    line-height: 1.6;
    color: var(--text-dim);
    font-size: 14px;
  }
  .links {
    display: flex;
    gap: 8px;
  }
  .links .pill-btn {
    padding: 7px 13px;
    font-size: 12.5px;
    text-decoration: none;
  }
  .license {
    margin: 16px 0 4px;
    padding: 12px 14px;
    border-radius: 12px;
    background: rgba(255, 190, 110, 0.08);
    border: 1px solid rgba(255, 190, 110, 0.18);
    font-size: 12.5px;
    line-height: 1.55;
    color: var(--text-dim);
  }
  .license strong {
    color: #ffe0b0;
  }
  h3 {
    margin: 22px 0 8px;
    font-size: 10.5px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    border-radius: 12px;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.05);
    display: grid;
    gap: 1px;
  }
  li {
    display: grid;
    grid-template-columns: 1.1fr 2fr auto;
    gap: 12px;
    align-items: baseline;
    padding: 8px 12px;
    background: rgba(10, 14, 30, 0.4);
    font-size: 12.5px;
  }
  .what {
    color: var(--text);
    text-decoration: none;
  }
  a.what:hover {
    color: var(--accent);
  }
  .what em {
    color: var(--warm);
    font-style: normal;
    font-size: 11px;
  }
  .who {
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .lic {
    color: var(--text-faint);
    font-size: 11.5px;
    white-space: nowrap;
  }
  @media (max-width: 640px) {
    li {
      grid-template-columns: 1fr auto;
    }
    .who {
      grid-column: 1 / -1;
      grid-row: 2;
    }
    .content {
      min-height: 0;
      padding: 6px 16px 20px;
    }
    header {
      padding-left: 16px;
    }
  }
</style>
