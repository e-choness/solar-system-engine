<script lang="ts">
  import { ChevronRight, X } from '@lucide/svelte';
  import { CATALOG, childrenOf } from '../data/catalog.ts';
  import type { BodyDef, BodyKind } from '../data/types.ts';
  import Grab from './Grab.svelte';
  import { app, engine } from './state.svelte.ts';

  const groups: Array<{ title: string; kinds: BodyKind[] }> = [
    { title: 'Star', kinds: ['star'] },
    { title: 'Planets', kinds: ['planet'] },
    { title: 'Dwarf planets', kinds: ['dwarf'] },
    { title: 'Asteroids', kinds: ['asteroid'] },
    { title: 'Comets', kinds: ['comet'] },
  ];

  let open = $state<Record<string, boolean>>({ earth: true });
  let collapsed = $state<Record<string, boolean>>({});

  const focusId = $derived(app.telemetry?.focusId);
</script>

{#snippet row(b: BodyDef, depth: number)}
  {@const moons = childrenOf(b.id)}
  <li>
    <div class="row" class:selected={app.selectedId === b.id} class:focus={focusId === b.id} style:--depth={depth}>
      {#if moons.length}
        <button class="twisty" class:open={open[b.id]} aria-label="Show moons of {b.name}" onclick={() => (open[b.id] = !open[b.id])}>
          <ChevronRight size={13} />
        </button>
      {:else}
        <span class="twisty-space"></span>
      {/if}
      <button class="item" onclick={() => engine.focus(b.id)} onmouseenter={() => (app.hoveredId = b.id)} onmouseleave={() => (app.hoveredId = null)}>
        <span class="dot kind-{b.kind}" style:--c={b.visual.color}></span>
        <span class="name">{b.name}</span>
        {#if moons.length}<span class="count">{moons.length}</span>{/if}
      </button>
    </div>
    {#if moons.length && open[b.id]}
      <ul>
        {#each moons as m (m.id)}{@render row(m, depth + 1)}{/each}
      </ul>
    {/if}
  </li>
{/snippet}

<nav class="browser glass sheet sheet-left" aria-label="Solar system bodies">
  {#if app.compact}<Grab label="Close" ondown={() => (app.browserOpen = false)} ontap={() => (app.browserOpen = false)} />{/if}
  <div class="head">
    <span class="title">Explore</span>
    <span class="sub">{CATALOG.length} worlds</span>
    {#if app.compact}
      <button class="icon-btn close" aria-label="Close" onclick={() => (app.browserOpen = false)}><X size={16} /></button>
    {/if}
  </div>
  <div class="list scroll">
    {#each groups as g (g.title)}
      {@const items = CATALOG.filter((b) => g.kinds.includes(b.kind))}
      <section>
        <button class="group" onclick={() => (collapsed[g.title] = !collapsed[g.title])} aria-expanded={!collapsed[g.title]}>
          <ChevronRight size={12} class={collapsed[g.title] ? '' : 'rot'} />
          {g.title}
          <span class="n">{items.length}</span>
        </button>
        {#if !collapsed[g.title]}
          <ul>
            {#each items as b (b.id)}{@render row(b, 0)}{/each}
          </ul>
        {/if}
      </section>
    {/each}
  </div>
</nav>

<style>
  .browser {
    position: fixed;
    top: 72px;
    left: 14px;
    bottom: 104px;
    width: 236px;
    display: flex;
    flex-direction: column;
    z-index: 15;
    animation: slide-in 0.5s var(--ease) both;
  }
  @keyframes slide-in {
    from {
      opacity: 0;
      transform: translateX(-16px);
    }
  }
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: 14px 16px 8px;
  }
  .title {
    font-family: var(--font-display);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    font-size: 12px;
  }
  .sub {
    font-size: 11px;
    color: var(--text-faint);
  }
  .list {
    flex: 1;
    padding: 0 8px 12px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .group {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 10px 8px 6px;
    border: 0;
    background: none;
    color: var(--text-faint);
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    cursor: pointer;
  }
  .group :global(svg) {
    transition: transform 0.2s var(--ease);
  }
  .group :global(svg.rot) {
    transform: rotate(90deg);
  }
  .group .n {
    margin-left: auto;
    font-weight: 500;
    letter-spacing: 0;
  }
  .row {
    display: flex;
    align-items: center;
    padding-left: calc(var(--depth) * 14px);
    border-radius: 10px;
    transition: background 0.15s;
  }
  .row:hover {
    background: rgba(255, 255, 255, 0.06);
  }
  .row.selected {
    background: rgba(142, 197, 255, 0.14);
  }
  .row.focus .name {
    color: white;
    font-weight: 600;
  }
  .twisty,
  .twisty-space {
    flex: none;
    width: 22px;
    height: 28px;
    display: grid;
    place-items: center;
  }
  .twisty {
    border: 0;
    background: none;
    color: var(--text-faint);
    cursor: pointer;
    padding: 0;
  }
  .twisty :global(svg) {
    transition: transform 0.2s var(--ease);
  }
  .twisty.open :global(svg) {
    transform: rotate(90deg);
  }
  .item {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
    height: 30px;
    padding: 0 8px 0 2px;
    border: 0;
    background: none;
    cursor: pointer;
    text-align: left;
  }
  .dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--c);
    box-shadow: 0 0 8px var(--c);
  }
  .dot.kind-moon,
  .dot.kind-asteroid,
  .dot.kind-comet {
    width: 6px;
    height: 6px;
  }
  .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-dim);
    font-size: 13px;
  }
  .item:hover .name {
    color: var(--text);
  }
  .count {
    font-size: 10.5px;
    color: var(--text-faint);
    font-family: var(--font-mono);
  }
  @media (pointer: coarse) {
    .twisty,
    .twisty-space {
      width: 34px;
      height: 44px;
    }
    .item {
      height: 44px;
    }
    .name {
      font-size: 15px;
    }
    .group {
      padding: 14px 8px 8px;
      font-size: 11px;
    }
  }
  @media (max-width: 760px), (max-height: 520px) {
    .browser {
      height: 62vh;
      height: 62dvh;
    }
    .head {
      align-items: center;
      padding: 0 8px 4px 16px;
    }
    .close {
      margin-left: 10px;
    }
    .sub {
      margin-left: auto;
    }
  }
  @media (max-height: 520px) and (orientation: landscape) {
    .head {
      padding-top: 6px;
    }
  }
</style>
