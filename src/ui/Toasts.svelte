<script lang="ts">
  import { flip } from 'svelte/animate';
  import { fly } from 'svelte/transition';
  import { app } from './state.svelte.ts';
</script>

<div class="toasts" aria-live="polite">
  {#each app.toasts as t (t.id)}
    <div class="toast glass" class:warn={t.tone === 'warn'} animate:flip={{ duration: 250 }} transition:fly={{ y: -10, duration: 300 }}>
      {t.text}
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    top: 74px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    z-index: 60;
    pointer-events: none;
  }
  .toast {
    padding: 9px 16px;
    border-radius: 999px;
    font-size: 13px;
    color: var(--text);
    max-width: min(560px, 90vw);
    text-align: center;
  }
  .toast.warn {
    border-color: rgba(255, 190, 110, 0.4);
    color: #ffe0b0;
  }
  @media (max-width: 760px), (max-height: 520px) {
    .toasts {
      top: var(--dock-top);
      width: max-content;
      max-width: calc(100vw - 24px);
    }
    .toast {
      border-radius: 16px;
    }
  }
</style>
