<script lang="ts">
  import { onMount } from 'svelte';
  import { BODY_BY_ID } from './data/catalog.ts';
  import { AU_KM } from './engine/astro.ts';
  import { forceWebGL, MOBILE, webglForced } from './engine/device.ts';
  import Browser from './ui/Browser.svelte';
  import Credits from './ui/Credits.svelte';
  import Events from './ui/Events.svelte';
  import Help from './ui/Help.svelte';
  import InfoPanel from './ui/InfoPanel.svelte';
  import Loader from './ui/Loader.svelte';
  import SettingsPanel from './ui/SettingsPanel.svelte';
  import { app, audio, closeSheets, engine, toast, updateSettings } from './ui/state.svelte.ts';
  import TimeBar from './ui/TimeBar.svelte';
  import Toasts from './ui/Toasts.svelte';
  import Tooltip from './ui/Tooltip.svelte';
  import TopBar from './ui/TopBar.svelte';
  import { RATE_STEPS } from './ui/format.ts';

  let stageEl: HTMLDivElement;
  let labelsEl: HTMLDivElement;

  const PLANET_KEYS = ['sun', 'mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto'];

  /** On a small screen an open sheet takes the space the details card would use. */
  const sheetOpen = $derived(app.compact && (app.browserOpen || app.settingsOpen || app.eventsOpen));

  onMount(() => {
    const offs: Array<() => void> = [];
    if (MOBILE) {
      const onVisibility = () => audio.setBackgrounded(document.hidden);
      const wake = () => audio.wake();
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('pointerdown', wake);
      offs.push(() => {
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('pointerdown', wake);
      });
    }
    (async () => {
      try {
        await engine.init(stageEl, labelsEl, $state.snapshot(app.settings), (p, label) => {
          app.progress = p;
          app.progressLabel = label;
        });
        app.backend = engine.backend;
        offs.push(
          engine.on('frame', (t) => {
            app.telemetry = t;
            const playing = audio.playingId ? engine.get(audio.playingId) : null;
            if (playing) {
              const live = engine.live(playing.def.id);
              if (live) audio.setProximity(live.cameraDistanceKm / playing.def.physical.radius);
            }
            const au = t.sunDistance / AU_KM;
            audio.setDeepSpace(Math.min(1, Math.max(0, Math.log10(au / 30) / Math.log10(200 / 30))));
          }),
          engine.on('select', (id) => {
            app.selectedId = id;
            if (app.stage !== 'explore') return;
            if (id && app.compact) closeSheets();
            if (id) {
              audio.sfx('click');
              if (app.settings.autoPlayBodySounds) audio.playBody(BODY_BY_ID.get(id)!);
            } else {
              audio.stopBody();
            }
          }),
          engine.on('hover', (id) => {
            app.hoveredId = id;
            if (id && app.stage === 'explore') audio.sfx('hover');
          }),
          engine.on('flight', ({ duration }) => {
            if (app.compact) closeSheets();
            audio.whoosh(duration);
          }),
          engine.on('tap', () => {
            if (app.compact) closeSheets();
          }),
          engine.on('lost', (reason) => {
            console.error('GPU context lost:', reason);
            if (MOBILE && engine.backend === 'WebGPU') forceWebGL();
            app.error = reason;
            app.lost = true;
            app.stage = 'error';
          }),
        );
        engine.start();
        app.stage = 'title';
        // On a phone WebGL 2 is the normal case, and there is nothing the player could do about it.
        if (engine.backend !== 'WebGPU' && !MOBILE) toast('WebGPU is unavailable in this browser — running on WebGL 2.', 'warn', 6000);
      } catch (err) {
        console.error(err);
        // A phone whose WebGPU driver can't run the engine may still manage WebGL 2.
        if (MOBILE && !webglForced()) {
          forceWebGL();
          location.reload();
          return;
        }
        app.error = err instanceof Error ? err.message : String(err);
        app.stage = 'error';
      }
    })();
    return () => offs.forEach((f) => f());
  });

  function stepRate(dir: 1 | -1) {
    const r = engine.rate;
    const sign = Math.sign(r) || 1;
    const i = RATE_STEPS.indexOf(Math.abs(r));
    let next: number;
    if (sign > 0) next = dir > 0 ? RATE_STEPS[Math.min(RATE_STEPS.length - 1, i + 1)] : i === 0 ? -1 : RATE_STEPS[i - 1];
    else next = dir < 0 ? -RATE_STEPS[Math.min(RATE_STEPS.length - 1, i + 1)] : i === 0 ? 1 : -RATE_STEPS[i - 1];
    engine.setRate(next);
    audio.sfx('warp');
  }

  function onKey(e: KeyboardEvent) {
    if (app.stage !== 'explore') return;
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select')) {
      if (e.key === 'Escape') target.blur();
      return;
    }
    const k = e.key;
    if (k === ' ') {
      e.preventDefault();
      engine.setPaused(!engine.paused);
    } else if (k === ']' || k === '.') stepRate(1);
    else if (k === '[' || k === ',') stepRate(-1);
    else if (k === 'n' || k === 'N') engine.now();
    else if ((k === 'f' || k === 'F') && app.selectedId) engine.focus(app.selectedId);
    else if (k === 'Escape') {
      if (app.settingsOpen || app.helpOpen || app.creditsOpen || app.eventsOpen) {
        app.settingsOpen = app.helpOpen = app.creditsOpen = app.eventsOpen = false;
      } else engine.select(null);
    } else if (k === 'o' || k === 'O') updateSettings({ orbits: !app.settings.orbits });
    else if (k === 'l' || k === 'L') updateSettings({ labels: !app.settings.labels });
    else if (k === 'b' || k === 'B') updateSettings({ belts: !app.settings.belts });
    else if (k === 'h' || k === 'H') app.hideUi = !app.hideUi;
    else if (k === 'm' || k === 'M') updateSettings({ muted: !app.settings.muted });
    else if (k === '?') app.helpOpen = !app.helpOpen;
    else if (k === '/') {
      e.preventDefault();
      document.querySelector<HTMLInputElement>('#search')?.focus();
    } else if (/^[0-9]$/.test(k)) engine.focus(PLANET_KEYS[Number(k)]);
    else if (k === 'ArrowLeft') engine.rig.rotate(0.12, 0);
    else if (k === 'ArrowRight') engine.rig.rotate(-0.12, 0);
    else if (k === 'ArrowUp') engine.rig.rotate(0, 0.08);
    else if (k === 'ArrowDown') engine.rig.rotate(0, -0.08);
    else if (k === '+' || k === '=') engine.rig.zoom(-0.35);
    else if (k === '-' || k === '_') engine.rig.zoom(0.35);
  }

  async function begin() {
    // A browser that refuses audio must not leave the player stuck on the title screen.
    await audio.start().catch((err) => console.warn('audio unavailable:', err));
    audio.applySettings($state.snapshot(app.settings));
    app.stage = 'explore';
    setTimeout(() => engine.focus('earth'), 350);
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="stage" bind:this={stageEl}></div>
<div class="labels" bind:this={labelsEl} class:hidden={app.stage !== 'explore' || app.hideUi}></div>

{#if app.stage === 'explore' && !app.hideUi}
  <TopBar />
  {#if app.browserOpen}<Browser />{/if}
  {#if app.selectedId && !sheetOpen}<InfoPanel id={app.selectedId} />{/if}
  <TimeBar onstep={stepRate} />
  {#if app.settingsOpen}<SettingsPanel />{/if}
  {#if app.eventsOpen}<Events />{/if}
  {#if !MOBILE}<Tooltip />{/if}
{/if}
{#if app.helpOpen}<Help />{/if}
{#if app.creditsOpen}<Credits />{/if}
{#if app.stage === 'explore' && app.hideUi}
  <button class="unhide glass" onclick={() => (app.hideUi = false)} title="Show interface (H)">Show interface</button>
{/if}
{#if app.stage !== 'explore'}<Loader onbegin={begin} />{/if}
<Toasts />

<style>
  .stage {
    position: fixed;
    inset: 0;
  }
  .labels.hidden {
    visibility: hidden;
  }
  .unhide {
    position: fixed;
    right: calc(16px + var(--safe-r));
    bottom: calc(16px + var(--safe-b));
    padding: 8px 14px;
    border-radius: 999px;
    color: var(--text-dim);
    cursor: pointer;
    font-size: 12px;
    opacity: 0.4;
    transition: opacity 0.2s;
  }
  .unhide:hover {
    opacity: 1;
  }
</style>
