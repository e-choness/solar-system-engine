import { AudioEngine } from '../audio/AudioEngine.ts';
import { MOBILE } from '../engine/device.ts';
import { Engine, type Telemetry } from '../engine/Engine.ts';
import { loadSettings, type Settings, saveSettings } from '../engine/settings.ts';

export type Stage = 'loading' | 'title' | 'explore' | 'error';

export interface Toast {
  id: number;
  text: string;
  tone?: 'info' | 'warn';
}

const initialSettings = loadSettings();
/** The same breakpoint as the compact rules in global.css. */
const compactQuery = window.matchMedia('(max-width: 760px), (max-height: 520px)');

/** Global reactive UI state (Svelte 5 runes). */
export const app = $state({
  stage: 'loading' as Stage,
  progress: 0,
  progressLabel: 'Starting engine',
  backend: '',
  error: '',
  settings: initialSettings as Settings,
  telemetry: null as Telemetry | null,
  selectedId: null as string | null,
  hoveredId: null as string | null,
  /** Small viewport: panels become sheets and only one shows at a time. */
  compact: compactQuery.matches,
  /** The GPU context is gone and the page needs a reload. */
  lost: false,
  browserOpen: !MOBILE && !compactQuery.matches,
  settingsOpen: false,
  helpOpen: false,
  creditsOpen: false,
  eventsOpen: false,
  hideUi: false,
  toasts: [] as Toast[],
});

compactQuery.addEventListener('change', (e) => (app.compact = e.matches));

/** Non-reactive singletons shared across components. */
export const engine = new Engine();
export const audio = new AudioEngine(initialSettings);

/** Clears the sheets that share the bottom of a small screen. */
export function closeSheets() {
  app.browserOpen = app.settingsOpen = app.eventsOpen = false;
}

let toastId = 0;
export function toast(text: string, tone: Toast['tone'] = 'info', ms = 4200) {
  const id = ++toastId;
  app.toasts.push({ id, text, tone });
  setTimeout(() => {
    const i = app.toasts.findIndex((t) => t.id === id);
    if (i >= 0) app.toasts.splice(i, 1);
  }, ms);
}

export function updateSettings(patch: Partial<Settings>) {
  Object.assign(app.settings, patch);
  const snapshot = $state.snapshot(app.settings) as Settings;
  saveSettings(snapshot);
  engine.applySettings(snapshot);
  audio.applySettings(snapshot);
}
