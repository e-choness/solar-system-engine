<script lang="ts">
  import { CalendarClock, X } from '@lucide/svelte';
  import { BODY_BY_ID } from '../data/catalog.ts';
  import { jdFromDate } from '../engine/astro.ts';
  import Grab from './Grab.svelte';
  import { app, audio, engine, toast } from './state.svelte.ts';

  interface SkyEvent {
    when: string;
    title: string;
    focus: string;
    /** Simulation rate after the jump (sim seconds per real second). */
    rate: number;
    /** Arrive this many hours before the moment so it plays out on screen. */
    leadH: number;
    text: string;
  }

  const EVENTS: SkyEvent[] = [
    { when: '1846-09-23T22:00Z', title: 'Neptune is found', focus: 'neptune', rate: 3600, leadH: 0, text: 'Johann Galle spots the planet within 1° of where Le Verrier’s mathematics said it would be.' },
    { when: '1930-02-18T12:00Z', title: 'Pluto is discovered', focus: 'pluto', rate: 3600, leadH: 0, text: 'Clyde Tombaugh blinks two photographic plates at Lowell Observatory and sees a dot move.' },
    { when: '1969-07-20T20:17Z', title: 'Apollo 11 lands', focus: 'moon', rate: 60, leadH: 0.25, text: 'The Eagle touches down in the Sea of Tranquillity. Humans walk on another world.' },
    { when: '1986-01-24T17:59Z', title: 'Voyager 2 at Uranus', focus: 'uranus', rate: 600, leadH: 2, text: 'The only spacecraft ever to visit Uranus passes 81,500 km above its clouds.' },
    { when: '1986-02-09T00:00Z', title: 'Halley at perihelion', focus: 'halley', rate: 86400, leadH: 24 * 20, text: 'Halley’s Comet rounds the Sun; Giotto flies through its coma a month later.' },
    { when: '1989-08-25T03:56Z', title: 'Voyager 2 at Neptune', focus: 'triton', rate: 600, leadH: 2, text: 'Last stop of the Grand Tour: geysers on Triton and Neptune’s Great Dark Spot.' },
    { when: '1994-07-16T20:13Z', title: 'Shoemaker–Levy 9 hits Jupiter', focus: 'jupiter', rate: 3600, leadH: 1, text: 'Twenty-one fragments of a torn-apart comet slam into Jupiter over six days.' },
    { when: '1997-04-01T00:00Z', title: 'Hale–Bopp at its brightest', focus: 'halebopp', rate: 86400, leadH: 24 * 15, text: 'The Great Comet of 1997, visible to the naked eye for a record 18 months.' },
    { when: '2005-01-14T11:38Z', title: 'Huygens lands on Titan', focus: 'titan', rate: 60, leadH: 0.5, text: 'The first landing in the outer Solar System, on a plain of water-ice pebbles.' },
    { when: '2014-11-12T15:34Z', title: 'Philae lands on 67P', focus: '67p', rate: 60, leadH: 0.5, text: 'Rosetta’s lander bounces twice before settling on the comet’s smaller lobe.' },
    { when: '2015-07-14T11:49Z', title: 'New Horizons at Pluto', focus: 'pluto', rate: 600, leadH: 3, text: 'A blurry dot becomes a world with a nitrogen-ice heart and mountains of water ice.' },
    { when: '2017-09-15T10:31Z', title: 'Cassini’s Grand Finale', focus: 'saturn', rate: 600, leadH: 2, text: 'After 13 years at Saturn, Cassini plunges into the planet it studied.' },
    { when: '2019-01-01T05:33Z', title: 'New Horizons at Arrokoth', focus: 'arrokoth', rate: 60, leadH: 0.5, text: 'The most distant object ever explored: a pristine contact binary 6.6 billion km out.' },
    { when: '2020-12-21T18:20Z', title: 'Great conjunction', focus: 'jupiter', rate: 3600, leadH: 6, text: 'From Earth, Jupiter and Saturn appear just 0.1° apart — the closest since 1623.' },
    { when: '2022-09-26T23:14Z', title: 'DART hits Dimorphos', focus: 'didymos', rate: 60, leadH: 0.5, text: 'Humanity deliberately changes the orbit of a celestial body for the first time.' },
    { when: '2025-03-23T00:00Z', title: 'Saturn’s rings go edge-on', focus: 'saturn', rate: 86400, leadH: 0, text: 'Earth crosses Saturn’s ring plane and the rings all but vanish from view.' },
    { when: '2027-02-20T00:00Z', title: 'Mars opposition', focus: 'mars', rate: 21600, leadH: 24, text: 'Earth overtakes Mars; the Red Planet is up all night at its brightest of the year.' },
    { when: '2029-04-13T21:46Z', title: 'Apophis skims Earth', focus: 'apophis', rate: 600, leadH: 6, text: 'A 340 m asteroid passes below geostationary satellites, visible to the naked eye.' },
    { when: '2030-04-11T00:00Z', title: 'Europa Clipper arrives', focus: 'europa', rate: 3600, leadH: 0, text: 'NASA’s largest planetary probe begins 49 flybys of the ocean moon.' },
    { when: '2061-07-28T00:00Z', title: 'Halley returns', focus: 'halley', rate: 86400, leadH: 24 * 20, text: 'Halley’s Comet reaches perihelion again, 75 years after its last visit.' },
    { when: '2126-07-12T00:00Z', title: 'Swift–Tuttle returns', focus: 'swifttuttle', rate: 86400, leadH: 24 * 20, text: 'Parent of the Perseid meteors, a 26 km nucleus, swings back past the Sun.' },
  ];

  const nowJd = jdFromDate(new Date());
  const items = EVENTS.map((e) => ({ ...e, jd: jdFromDate(new Date(e.when)) }));
  const upcoming = items.filter((e) => e.jd >= nowJd);
  const past = items.filter((e) => e.jd < nowJd).reverse();

  function go(e: (typeof items)[number]) {
    engine.setJd(e.jd - e.leadH / 24);
    engine.setRate(e.rate);
    engine.setPaused(false);
    engine.focus(e.focus);
    audio.sfx('warp');
    app.eventsOpen = false;
    toast(`${e.title} — ${e.when.slice(0, 10)}`);
  }

  const fmt = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
</script>

{#snippet list(group: typeof items)}
  <ul>
    {#each group as e (e.when + e.title)}
      {@const b = BODY_BY_ID.get(e.focus)!}
      <li>
        <button onclick={() => go(e)}>
          <span class="dot" style:--c={b.visual.color}></span>
          <span class="txt">
            <span class="t">{e.title}</span>
            <span class="d mono">{fmt(e.when)} · {b.name}</span>
            <span class="p">{e.text}</span>
          </span>
        </button>
      </li>
    {/each}
  </ul>
{/snippet}

<section class="panel glass sheet" aria-label="Time travel">
  {#if app.compact}<Grab label="Close" ondown={() => (app.eventsOpen = false)} ontap={() => (app.eventsOpen = false)} />{/if}
  <header>
    <h2><CalendarClock size={17} /> Time travel</h2>
    <button class="icon-btn" aria-label="Close" onclick={() => (app.eventsOpen = false)}><X size={16} /></button>
  </header>
  <div class="scroll content">
    <h3>Coming up</h3>
    {@render list(upcoming)}
    <h3>History</h3>
    {@render list(past)}
    <p class="note">
      Orbits are two-body fits to 2026 data, so moments decades away are approximate. Spacecraft are not shown — the worlds they visited are.
    </p>
  </div>
</section>

<style>
  .panel {
    position: fixed;
    top: 72px;
    right: 14px;
    width: 360px;
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
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 600;
  }
  .content {
    padding: 0 10px 14px;
  }
  h3 {
    margin: 14px 8px 6px;
    font-size: 10.5px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li button {
    display: flex;
    gap: 12px;
    width: 100%;
    padding: 10px 8px;
    border: 0;
    border-radius: 12px;
    background: none;
    text-align: left;
    cursor: pointer;
    transition: background 0.15s;
  }
  li button:hover {
    background: rgba(255, 255, 255, 0.07);
  }
  .dot {
    flex: none;
    margin-top: 5px;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--c);
    box-shadow: 0 0 10px var(--c);
  }
  .txt {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .t {
    font-size: 13.5px;
    font-weight: 600;
    color: var(--text);
  }
  .d {
    font-size: 11px;
    color: var(--accent);
  }
  .p {
    font-size: 12px;
    line-height: 1.45;
    color: var(--text-dim);
  }
  .note {
    margin: 12px 8px 0;
    font-size: 11px;
    line-height: 1.5;
    color: var(--text-faint);
  }
  @media (max-width: 760px), (max-height: 520px), (pointer: coarse) and (max-width: 900px) {
    header {
      padding-top: 0;
    }
  }
</style>
