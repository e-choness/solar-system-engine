<script lang="ts">
  import { RotateCcw, X } from '@lucide/svelte';
  import { DEFAULT_SETTINGS, QUALITY, type Quality, type Settings } from '../engine/settings.ts';
  import { app, audio, updateSettings } from './state.svelte.ts';

  type BoolKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];
  type NumKey = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];

  const toggles: Array<[BoolKey, string, string]> = [
    ['orbits', 'Orbit paths', 'O'],
    ['labels', 'Labels', 'L'],
    ['belts', 'Asteroid belts & Oort cloud', 'B'],
    ['tails', 'Comet tails', ''],
    ['bloom', 'Bloom & lens flare', ''],
  ];
  const volumes: Array<[NumKey, string]> = [
    ['masterVolume', 'Master'],
    ['musicVolume', 'Soundtrack'],
    ['bodyVolume', 'World sounds'],
    ['ambienceVolume', 'Ambience'],
    ['uiVolume', 'Interface'],
  ];

  const set = (patch: Partial<Settings>) => updateSettings(patch);
</script>

<section class="panel glass" aria-label="Settings">
  <header>
    <h2>Settings</h2>
    <button class="icon-btn" aria-label="Close settings" onclick={() => (app.settingsOpen = false)}><X size={16} /></button>
  </header>

  <div class="scroll content">
    <h3>Graphics</h3>
    <div class="seg" role="radiogroup" aria-label="Quality">
      {#each Object.entries(QUALITY) as [q, preset] (q)}
        <button role="radio" aria-checked={app.settings.quality === q} class:on={app.settings.quality === q} onclick={() => set({ quality: q as Quality })}>
          {preset.label}
        </button>
      {/each}
    </div>
    <p class="hint">Ultra streams full-resolution 8K surface maps for every world you visit.</p>

    {#each toggles as [key, label, kbd] (key)}
      <label class="row">
        <span>{label}{#if kbd}<kbd>{kbd}</kbd>{/if}</span>
        <input type="checkbox" class="switch" checked={app.settings[key]} onchange={(e) => set({ [key]: e.currentTarget.checked })} />
      </label>
    {/each}
    <label class="row slider">
      <span>Milky Way brightness</span>
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={app.settings.milkyWay}
        oninput={(e) => set({ milkyWay: Number(e.currentTarget.value) })}
      />
    </label>

    <h3>Sound</h3>
    <label class="row">
      <span>Mute everything<kbd>M</kbd></span>
      <input type="checkbox" class="switch" checked={app.settings.muted} onchange={(e) => set({ muted: e.currentTarget.checked })} />
    </label>
    <label class="row">
      <span>Play a world’s sound when selected</span>
      <input
        type="checkbox"
        class="switch"
        checked={app.settings.autoPlayBodySounds}
        onchange={(e) => set({ autoPlayBodySounds: e.currentTarget.checked })}
      />
    </label>
    {#each volumes as [key, label] (key)}
      <label class="row slider">
        <span>{label}<output class="mono">{Math.round(app.settings[key] * 100)}</output></span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={app.settings[key]}
          oninput={(e) => set({ [key]: Number(e.currentTarget.value) })}
          onchange={() => key === 'uiVolume' && audio.sfx('click')}
        />
      </label>
    {/each}

    <button class="pill-btn reset" onclick={() => set({ ...DEFAULT_SETTINGS })}><RotateCcw size={14} /> Restore defaults</button>
  </div>
</section>

<style>
  .panel {
    position: fixed;
    top: 72px;
    right: 14px;
    width: 330px;
    max-height: calc(100vh - 190px);
    display: flex;
    flex-direction: column;
    z-index: 25;
    animation: drop 0.3s var(--ease) both;
  }
  @keyframes drop {
    from {
      opacity: 0;
      transform: translateY(-8px);
    }
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 10px 4px 18px;
  }
  h2 {
    margin: 0;
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 600;
  }
  .content {
    padding: 4px 18px 18px;
  }
  h3 {
    margin: 16px 0 10px;
    font-size: 10.5px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .seg {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 3px;
    padding: 3px;
    border-radius: 11px;
    background: rgba(0, 0, 0, 0.25);
  }
  .seg button {
    padding: 7px 0;
    border: 0;
    border-radius: 8px;
    background: none;
    color: var(--text-dim);
    font-size: 12.5px;
    cursor: pointer;
    transition: background 0.15s;
  }
  .seg button.on {
    background: rgba(142, 197, 255, 0.22);
    color: white;
  }
  .hint {
    margin: 8px 0 6px;
    font-size: 11.5px;
    color: var(--text-faint);
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 0;
    font-size: 13px;
    color: var(--text-dim);
    cursor: pointer;
  }
  .row.slider {
    flex-direction: column;
    align-items: stretch;
    gap: 4px;
  }
  .row span {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  output {
    margin-left: auto;
    font-size: 11.5px;
    color: var(--text-faint);
  }
  kbd {
    font-family: var(--font-mono);
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 4px;
    border: 1px solid rgba(255, 255, 255, 0.16);
    color: var(--text-faint);
  }
  input[type='range'] {
    width: 100%;
    accent-color: var(--accent);
  }
  .switch {
    appearance: none;
    flex: none;
    width: 34px;
    height: 20px;
    border-radius: 99px;
    background: rgba(255, 255, 255, 0.14);
    position: relative;
    cursor: pointer;
    transition: background 0.2s;
  }
  .switch::after {
    content: '';
    position: absolute;
    top: 3px;
    left: 3px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: white;
    transition: transform 0.2s var(--ease);
  }
  .switch:checked {
    background: var(--accent);
  }
  .switch:checked::after {
    transform: translateX(14px);
  }
  .reset {
    margin-top: 14px;
    font-size: 12.5px;
    padding: 8px 14px;
  }
</style>
