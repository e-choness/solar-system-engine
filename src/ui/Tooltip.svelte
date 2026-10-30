<script lang="ts">
  import { BODY_BY_ID } from '../data/catalog.ts';
  import { distanceText, KIND_LABEL } from './format.ts';
  import { app, engine } from './state.svelte.ts';

  let x = $state(0);
  let y = $state(0);

  const def = $derived(app.hoveredId && app.hoveredId !== app.selectedId ? BODY_BY_ID.get(app.hoveredId) : null);
  const dist = $derived.by(() => {
    if (!def || !app.telemetry) return '';
    const live = engine.live(def.id);
    return live ? distanceText(Math.max(0, live.cameraDistanceKm - def.physical.radius)) : '';
  });
</script>

<svelte:window
  onpointermove={(e) => {
    x = e.clientX;
    y = e.clientY;
  }}
/>

{#if def}
  <div class="tip glass" style:left="{x + 16}px" style:top="{y + 18}px" role="tooltip">
    <span class="dot" style:background={def.visual.color}></span>
    <span class="name">{def.name}</span>
    <span class="kind">{KIND_LABEL[def.kind]}</span>
    {#if dist}<span class="dist mono">{dist}</span>{/if}
  </div>
{/if}

<style>
  .tip {
    position: fixed;
    z-index: 30;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 11px;
    border-radius: 10px;
    pointer-events: none;
    font-size: 12.5px;
    white-space: nowrap;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  .name {
    font-weight: 600;
  }
  .kind,
  .dist {
    color: var(--text-faint);
    font-size: 11.5px;
  }
</style>
