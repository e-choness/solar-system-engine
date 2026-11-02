<script lang="ts">
  let {
    onup,
    ondown,
    ontap,
    label,
  }: {
    /** Swiped up. */
    onup?: () => void;
    /** Swiped down. */
    ondown?: () => void;
    ontap?: () => void;
    label: string;
  } = $props();

  let el: HTMLButtonElement;
  let start = 0;
  let dy = 0;
  let dragging = false;

  const sheet = () => el.closest<HTMLElement>('.sheet');

  function press(e: PointerEvent) {
    el.setPointerCapture(e.pointerId);
    start = e.clientY;
    dy = 0;
    dragging = true;
    const s = sheet();
    if (s) s.style.transition = 'none';
  }

  function move(e: PointerEvent) {
    if (!dragging) return;
    dy = e.clientY - start;
    // Down follows the finger; up only hints, because up means "expand".
    const s = sheet();
    if (s) s.style.translate = `0 ${dy > 0 ? dy : dy / 4}px`;
  }

  function release() {
    if (!dragging) return;
    dragging = false;
    const s = sheet();
    if (s) {
      s.style.transition = '';
      s.style.translate = '';
    }
    if (dy > 48) ondown?.();
    else if (dy < -32) onup?.();
  }
</script>

<button
  bind:this={el}
  class="grab"
  aria-label={label}
  onpointerdown={press}
  onpointermove={move}
  onpointerup={release}
  onpointercancel={release}
  onclick={() => {
    // A swipe also ends in a click on the handle.
    if (Math.abs(dy) < 8) ontap?.();
  }}
>
  <span></span>
</button>

<style>
  .grab {
    display: grid;
    place-items: center;
    width: 100%;
    height: 24px;
    padding: 0;
    border: 0;
    background: none;
    cursor: grab;
    touch-action: none;
  }
  span {
    width: 38px;
    height: 4px;
    border-radius: 99px;
    background: rgba(255, 255, 255, 0.3);
  }
  @media (max-height: 520px) and (orientation: landscape) {
    /* Side sheets have nothing to swipe. */
    .grab {
      display: none;
    }
  }
</style>
