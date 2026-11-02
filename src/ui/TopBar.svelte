<script lang="ts">
  import { CalendarClock, Ellipsis, Expand, Eye, Hand, Info, Keyboard, ListTree, Minimize, Search, Settings, Volume2, VolumeX } from '@lucide/svelte';
  import { CATALOG } from '../data/catalog.ts';
  import { CAN_FULLSCREEN, MOBILE } from '../engine/device.ts';
  import { KIND_LABEL } from './format.ts';
  import { app, audio, closeSheets, engine, updateSettings } from './state.svelte.ts';

  let query = $state('');
  let active = $state(0);
  let focused = $state(false);
  let fullscreen = $state(false);
  let menuOpen = $state(false);

  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]/g, '');

  const results = $derived.by(() => {
    const q = norm(query);
    if (!q) return [];
    return CATALOG.map((b) => {
      const n = norm(b.name);
      const score = n.startsWith(q) ? 0 : n.includes(q) ? 1 : norm(b.class).includes(q) ? 2 : 9;
      return { b, score };
    })
      .filter((r) => r.score < 9)
      .sort((a, b) => a.score - b.score || a.b.name.localeCompare(b.b.name))
      .slice(0, 8)
      .map((r) => r.b);
  });

  function choose(id: string) {
    engine.focus(id);
    query = '';
    (document.activeElement as HTMLElement)?.blur();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      active = Math.min(results.length - 1, active + 1);
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      active = Math.max(0, active - 1);
      e.preventDefault();
    } else if (e.key === 'Enter' && results[active]) {
      choose(results[active].id);
    } else if (e.key === 'Escape') {
      query = '';
    }
  }

  function toggle(panel: 'settingsOpen' | 'helpOpen' | 'creditsOpen' | 'eventsOpen') {
    const open = !app[panel];
    app.settingsOpen = app.helpOpen = app.creditsOpen = app.eventsOpen = false;
    if (app.compact) closeSheets();
    app[panel] = open;
    audio.sfx(open ? 'open' : 'close');
  }

  function toggleBrowser() {
    const open = !app.browserOpen;
    if (app.compact) closeSheets();
    app.browserOpen = open;
  }

  async function toggleFullscreen() {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen().catch(() => undefined);
  }

  $effect(() => {
    const on = () => (fullscreen = Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  });
</script>

{#snippet menuItem(label: string, onselect: () => void, Icon: typeof Info)}
  <button
    role="menuitem"
    onclick={() => {
      menuOpen = false;
      onselect();
    }}
  >
    <Icon size={18} />
    {label}
  </button>
{/snippet}

<header class="bar">
  <div class="left glass">
    <button class="icon-btn" class:active={app.browserOpen} title="Bodies" aria-label="Toggle body browser" onclick={toggleBrowser}>
      <ListTree size={18} />
    </button>
    <div class="brand">
      <span class="sun"></span>
      <span class="word">Solar<b>System</b></span>
    </div>
    <div class="search" class:open={focused && results.length > 0}>
      <Search size={15} />
      <input
        id="search"
        type="search"
        placeholder={MOBILE ? 'Search worlds…' : 'Search worlds…  /'}
        autocomplete="off"
        spellcheck="false"
        bind:value={query}
        oninput={() => (active = 0)}
        onkeydown={onKey}
        onfocus={() => (focused = true)}
        onblur={() => setTimeout(() => (focused = false), 150)}
      />
      {#if focused && results.length}
        <ul class="results glass" role="listbox">
          {#each results as b, i (b.id)}
            <li role="option" aria-selected={i === active}>
              <button class:active={i === active} onmousedown={() => choose(b.id)}>
                <span class="dot" style:background={b.visual.color}></span>
                <span class="name">{b.name}</span>
                <span class="kind">{KIND_LABEL[b.kind]}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </div>

  {#if app.compact}
    <div class="right glass">
      <button class="icon-btn" class:active={menuOpen} aria-label="Menu" aria-haspopup="menu" aria-expanded={menuOpen} onclick={() => (menuOpen = !menuOpen)}>
        <Ellipsis size={20} />
      </button>
    </div>
    {#if menuOpen}
      <div class="scrim" role="presentation" onclick={() => (menuOpen = false)}></div>
      <div class="menu glass scroll" role="menu">
        {@render menuItem('Time travel', () => toggle('eventsOpen'), CalendarClock)}
        {@render menuItem('Settings', () => toggle('settingsOpen'), Settings)}
        {@render menuItem(app.settings.muted ? 'Unmute' : 'Mute', () => updateSettings({ muted: !app.settings.muted }), app.settings.muted ? VolumeX : Volume2)}
        {@render menuItem('Hide interface', () => (app.hideUi = true), Eye)}
        {#if CAN_FULLSCREEN}{@render menuItem(fullscreen ? 'Exit fullscreen' : 'Fullscreen', toggleFullscreen, fullscreen ? Minimize : Expand)}{/if}
        {@render menuItem('Controls', () => toggle('helpOpen'), MOBILE ? Hand : Keyboard)}
        {@render menuItem('About & credits', () => toggle('creditsOpen'), Info)}
      </div>
    {/if}
  {:else}
  <div class="right glass">
    <button class="icon-btn" class:active={app.eventsOpen} title="Time travel" aria-label="Time travel events" onclick={() => toggle('eventsOpen')}>
      <CalendarClock size={18} />
    </button>
    <button class="icon-btn" title="Hide interface (H)" aria-label="Hide interface" onclick={() => (app.hideUi = true)}>
      <Eye size={18} />
    </button>
    <button
      class="icon-btn"
      title={app.settings.muted ? 'Unmute (M)' : 'Mute (M)'}
      aria-label="Toggle sound"
      onclick={() => updateSettings({ muted: !app.settings.muted })}
    >
      {#if app.settings.muted}<VolumeX size={18} />{:else}<Volume2 size={18} />{/if}
    </button>
    <button class="icon-btn" class:active={app.settingsOpen} title="Settings" aria-label="Settings" onclick={() => toggle('settingsOpen')}>
      <Settings size={18} />
    </button>
    <button class="icon-btn" class:active={app.helpOpen} title="Controls (?)" aria-label="Controls" onclick={() => toggle('helpOpen')}>
      <Keyboard size={18} />
    </button>
    <button class="icon-btn" class:active={app.creditsOpen} title="About & credits" aria-label="About and credits" onclick={() => toggle('creditsOpen')}>
      <Info size={18} />
    </button>
    <button class="icon-btn" title="Fullscreen" aria-label="Toggle fullscreen" onclick={toggleFullscreen}>
      {#if fullscreen}<Minimize size={18} />{:else}<Expand size={18} />{/if}
    </button>
  </div>
  {/if}
</header>

<style>
  .bar {
    position: fixed;
    top: 14px;
    left: 14px;
    right: 14px;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    pointer-events: none;
    z-index: 20;
  }
  .left,
  .right {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 5px;
    border-radius: 16px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 0 10px 0 4px;
    font-family: var(--font-display);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    font-size: 13px;
    color: var(--text-dim);
  }
  .brand b {
    color: var(--text);
    font-weight: 700;
    margin-left: 4px;
  }
  .sun {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: radial-gradient(circle at 40% 40%, #fff6d8, #ffc35c 55%, #ff8a2a);
    box-shadow: 0 0 14px rgba(255, 180, 80, 0.8);
  }
  .search {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 38px;
    padding: 0 12px;
    border-radius: 12px;
    background: rgba(0, 0, 0, 0.22);
    border: 1px solid rgba(255, 255, 255, 0.08);
    color: var(--text-faint);
    width: 260px;
    transition:
      width 0.3s var(--ease),
      border-color 0.2s;
  }
  .search:focus-within {
    width: 320px;
    border-color: rgba(142, 197, 255, 0.45);
  }
  input {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: none;
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: 13.5px;
  }
  input::placeholder {
    color: var(--text-faint);
  }
  .results {
    position: absolute;
    top: calc(100% + 8px);
    left: 0;
    right: 0;
    margin: 0;
    padding: 6px;
    list-style: none;
    border-radius: 14px;
  }
  .results button {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 10px;
    border: 0;
    border-radius: 9px;
    background: transparent;
    cursor: pointer;
    text-align: left;
  }
  .results button.active,
  .results button:hover {
    background: rgba(255, 255, 255, 0.1);
  }
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    flex: none;
    box-shadow: 0 0 8px currentColor;
  }
  .name {
    flex: 1;
    color: var(--text);
  }
  .kind {
    font-size: 11px;
    color: var(--text-faint);
  }
  .scrim {
    position: fixed;
    inset: 0;
    pointer-events: auto;
  }
  .menu {
    position: absolute;
    top: 62px;
    right: 0;
    width: 220px;
    max-height: calc(100vh - var(--safe-t) - var(--safe-b) - 78px);
    max-height: calc(100dvh - var(--safe-t) - var(--safe-b) - 78px);
    padding: 6px;
    border-radius: 16px;
    pointer-events: auto;
    animation: menu-in 0.22s var(--ease) both;
  }
  @keyframes menu-in {
    from {
      opacity: 0;
      transform: translateY(-6px);
    }
  }
  .menu button {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 44px;
    padding: 0 12px;
    border: 0;
    border-radius: 10px;
    background: none;
    color: var(--text);
    font-size: 14.5px;
    text-align: left;
    cursor: pointer;
  }
  .menu button:active {
    background: rgba(255, 255, 255, 0.1);
  }
  @media (max-width: 760px), (max-height: 520px) {
    .bar {
      top: calc(8px + var(--safe-t));
      left: calc(8px + var(--safe-l));
      right: calc(8px + var(--safe-r));
      gap: 8px;
    }
    .left {
      flex: 1;
      min-width: 0;
      max-width: 420px;
    }
    .brand {
      display: none;
    }
    .search,
    .search:focus-within {
      flex: 1;
      width: auto;
      min-width: 0;
    }
  }
</style>
