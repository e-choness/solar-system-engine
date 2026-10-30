<script lang="ts">
  import { ChevronsLeft, ChevronsRight, Clock, Pause, Play } from '@lucide/svelte';
  import { dateFromJd, jdFromDate } from '../engine/astro.ts';
  import { JD_MAX, JD_MIN } from '../engine/Engine.ts';
  import { BODY_BY_ID } from '../data/catalog.ts';
  import { distanceText, rateLabel, utcDate } from './format.ts';
  import { app, audio, engine } from './state.svelte.ts';

  let { onstep }: { onstep: (dir: 1 | -1) => void } = $props();

  const t = $derived(app.telemetry);
  const when = $derived(t ? utcDate(dateFromJd(t.jd)) : null);
  const live = $derived(t ? Math.abs(t.jd - jdFromDate(new Date())) < 1 / 1440 && t.rate === 1 && !t.paused : false);
  const year = $derived(t ? dateFromJd(t.jd).getUTCFullYear() + (dateFromJd(t.jd).getUTCMonth() + 0.5) / 12 : 2026);
  const focus = $derived(t ? BODY_BY_ID.get(t.focusId) : null);
  let editing = $state(false);
  let draft = $state('');

  function togglePause() {
    engine.setPaused(!engine.paused);
    audio.sfx('click');
  }

  function goNow() {
    engine.now();
    engine.setRate(1);
    engine.setPaused(false);
    audio.sfx('warp');
  }

  function scrub(e: Event) {
    const y = Number((e.target as HTMLInputElement).value);
    const whole = Math.floor(y);
    const d = new Date(Date.UTC(whole, Math.round((y - whole) * 12), 1));
    const cur = dateFromJd(engine.jd);
    d.setUTCDate(Math.min(cur.getUTCDate(), 28));
    d.setUTCHours(cur.getUTCHours(), cur.getUTCMinutes());
    engine.setJd(jdFromDate(d));
  }

  function startEdit() {
    draft = when ? `${when.date} ${when.time.slice(0, 5)}` : '';
    editing = true;
  }

  function commit() {
    editing = false;
    const s = draft.trim().replace(' ', 'T');
    const d = new Date(/T/.test(s) ? `${s}Z` : `${s}T00:00Z`);
    if (!Number.isNaN(d.getTime())) {
      engine.setJd(jdFromDate(d));
      audio.sfx('warp');
    }
  }

  const minYear = dateFromJd(JD_MIN).getUTCFullYear();
  const maxYear = dateFromJd(JD_MAX).getUTCFullYear();
</script>

{#if t && when}
  <div class="timebar glass">
    <div class="when">
      {#if editing}
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="mono edit"
          bind:value={draft}
          autofocus
          onblur={commit}
          onkeydown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') editing = false;
          }}
          aria-label="Date and time (UTC)"
        />
      {:else}
        <button class="date mono" onclick={startEdit} title="Click to type a date">
          <span class="d">{when.date}</span>
          <span class="tm">{when.time}<small>UTC</small></span>
        </button>
      {/if}
      <span class="badge" class:live>
        <span class="pulse"></span>{live ? 'Live' : t.paused ? 'Paused' : rateLabel(t.rate)}
      </span>
    </div>

    <div class="controls">
      <button class="icon-btn" title="Slower / reverse ( [ )" aria-label="Slower" onclick={() => onstep(-1)}><ChevronsLeft size={18} /></button>
      <button class="icon-btn play" title="Pause (Space)" aria-label={t.paused ? 'Play' : 'Pause'} onclick={togglePause}>
        {#if t.paused}<Play size={18} />{:else}<Pause size={18} />{/if}
      </button>
      <button class="icon-btn" title="Faster ( ] )" aria-label="Faster" onclick={() => onstep(1)}><ChevronsRight size={18} /></button>
      <button class="pill-btn now" title="Return to the present (N)" onclick={goNow} disabled={live}><Clock size={14} /> Now</button>
    </div>

    <label class="scrub">
      <span class="sr">Year</span>
      <input type="range" min={minYear} max={maxYear - 0.01} step="0.0833" value={year} oninput={scrub} />
      <span class="ticks mono"><span>{minYear}</span><span>{maxYear}</span></span>
    </label>

    <div class="where">
      <span class="k">Orbiting</span>
      <span class="v">{focus?.name}</span>
      <span class="k">Altitude</span>
      <span class="v mono">{distanceText(Math.max(0, t.focusDistance - (focus?.physical.radius ?? 0)))}</span>
    </div>
  </div>
{/if}

<style>
  .timebar {
    position: fixed;
    left: 50%;
    bottom: 16px;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 18px;
    padding: 10px 14px 10px 18px;
    border-radius: 20px;
    z-index: 15;
    max-width: calc(100vw - 28px);
    animation: up 0.5s var(--ease) both;
  }
  @keyframes up {
    from {
      opacity: 0;
      transform: translate(-50%, 14px);
    }
  }
  .when {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .date {
    flex: none;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    border: 0;
    background: none;
    padding: 0;
    cursor: text;
    color: var(--text);
  }
  .d {
    font-size: 16px;
    font-weight: 600;
    letter-spacing: 0.02em;
    white-space: nowrap;
  }
  .tm {
    font-size: 11.5px;
    color: var(--text-dim);
  }
  .tm small {
    margin-left: 4px;
    color: var(--text-faint);
  }
  .edit {
    width: 160px;
    padding: 6px 8px;
    border-radius: 8px;
    border: 1px solid rgba(142, 197, 255, 0.5);
    background: rgba(0, 0, 0, 0.35);
    color: var(--text);
    outline: none;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 9px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-dim);
    background: rgba(255, 255, 255, 0.06);
    white-space: nowrap;
    min-width: 92px;
    justify-content: center;
  }
  .pulse {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
  }
  .badge.live {
    color: #9dffc4;
    background: rgba(70, 220, 140, 0.12);
  }
  .badge.live .pulse {
    background: #57f0a0;
    animation: blink 1.6s ease-in-out infinite;
  }
  @keyframes blink {
    50% {
      opacity: 0.25;
    }
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .play {
    background: rgba(255, 255, 255, 0.1);
  }
  .now {
    margin-left: 6px;
    padding: 7px 12px;
    font-size: 12.5px;
  }
  .now:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .scrub {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 220px;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
  input[type='range'] {
    width: 100%;
    accent-color: var(--accent);
    height: 18px;
  }
  .ticks {
    display: flex;
    justify-content: space-between;
    font-size: 9.5px;
    color: var(--text-faint);
  }
  .where {
    display: grid;
    grid-template-columns: auto auto;
    column-gap: 10px;
    row-gap: 1px;
    align-items: baseline;
    padding-left: 16px;
    border-left: 1px solid rgba(255, 255, 255, 0.08);
  }
  .where .k {
    font-size: 9.5px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .where .v {
    font-size: 12.5px;
    white-space: nowrap;
  }
  @media (max-width: 1100px) {
    .scrub {
      display: none;
    }
  }
  @media (max-width: 760px) {
    .where {
      display: none;
    }
    .timebar {
      gap: 10px;
      padding: 8px 10px;
    }
  }
</style>
