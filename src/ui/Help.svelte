<script lang="ts">
  import { Keyboard, Mouse, X } from '@lucide/svelte';
  import { app } from './state.svelte.ts';

  const mouse: Array<[string, string]> = [
    ['Drag', 'Orbit around the focused world'],
    ['Scroll / pinch', 'Zoom in and out — all the way to the Oort cloud'],
    ['Click', 'Select a world and show its details'],
    ['Double-click', 'Fly to a world'],
    ['Right-drag', 'Look around'],
  ];
  const keys: Array<[string[], string]> = [
    [['0', '–', '9'], 'Fly to the Sun, Mercury … Pluto'],
    [['F'], 'Fly to the selected world'],
    [['/'], 'Search'],
    [['Space'], 'Pause / resume time'],
    [['[', ']'], 'Slower / faster time (past zero runs backwards)'],
    [['N'], 'Back to the present moment'],
    [['←', '↑', '→', '↓'], 'Orbit the camera'],
    [['+', '−'], 'Zoom'],
    [['O'], 'Orbit paths'],
    [['L'], 'Labels'],
    [['B'], 'Belts & Oort cloud'],
    [['M'], 'Mute'],
    [['H'], 'Hide the interface (screenshots!)'],
    [['Esc'], 'Close panels / deselect'],
  ];
</script>

<div class="backdrop" role="presentation" onclick={() => (app.helpOpen = false)}></div>
<div class="modal glass" role="dialog" aria-modal="true" aria-label="Controls">
  <header>
    <h2>Controls</h2>
    <button class="icon-btn" aria-label="Close" onclick={() => (app.helpOpen = false)}><X size={16} /></button>
  </header>
  <div class="cols">
    <div>
      <h3><Mouse size={13} /> Mouse & touch</h3>
      <dl>
        {#each mouse as [k, v] (k)}
          <dt>{k}</dt>
          <dd>{v}</dd>
        {/each}
      </dl>
    </div>
    <div>
      <h3><Keyboard size={13} /> Keyboard</h3>
      <dl>
        {#each keys as [ks, v] (v)}
          <dt>{#each ks as k}{#if k === '–'}<span class="to">–</span>{:else}<kbd>{k}</kbd>{/if}{/each}</dt>
          <dd>{v}</dd>
        {/each}
      </dl>
    </div>
  </div>
  <p class="tip">
    Everything is at true scale: distances, sizes and positions are real. Planets look like points until you get close — that’s how empty space is.
  </p>
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
    width: min(760px, calc(100vw - 28px));
    max-height: calc(100vh - 40px);
    overflow: auto;
    padding: 18px 22px 20px;
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
    align-items: center;
    justify-content: space-between;
  }
  h2 {
    margin: 0;
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 20px;
  }
  .cols {
    display: grid;
    grid-template-columns: 1fr 1.2fr;
    gap: 28px;
    margin-top: 6px;
  }
  h3 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 14px 0 8px;
    font-size: 10.5px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 7px 14px;
    margin: 0;
    align-items: center;
  }
  dt {
    display: flex;
    gap: 4px;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text);
    white-space: nowrap;
  }
  dd {
    margin: 0;
    font-size: 12.5px;
    color: var(--text-dim);
  }
  kbd {
    min-width: 22px;
    padding: 2px 6px;
    border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-bottom-width: 2px;
    background: rgba(255, 255, 255, 0.06);
    font-family: var(--font-mono);
    font-size: 11px;
    text-align: center;
  }
  .to {
    color: var(--text-faint);
  }
  .tip {
    margin: 18px 0 0;
    padding: 12px 14px;
    border-radius: 12px;
    background: rgba(142, 197, 255, 0.08);
    font-size: 12.5px;
    line-height: 1.55;
    color: var(--text-dim);
  }
  @media (max-width: 640px) {
    .cols {
      grid-template-columns: 1fr;
      gap: 0;
    }
  }
</style>
